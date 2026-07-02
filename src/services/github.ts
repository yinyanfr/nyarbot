import config from "../configs/env.js";
import { logger } from "../libs/logger.js";

const API_BASE = config.githubApiBase;
const API_VERSION = config.githubApiVersion;

interface ContentItem {
  sha: string;
}

interface PutContentResponse {
  commit?: {
    sha?: string;
  };
}

interface PagesDeploymentResponse {
  status?: string;
}

interface PagesSiteResponse {
  status?: string | null;
}

interface PagesBuildResponse {
  status?: string;
  error?: { message?: string | null };
  commit?: string;
}

export interface GithubDiaryPushResult {
  owner: string;
  repo: string;
  path: string;
  commitSha: string;
}

export interface GithubPagesPublishStatus {
  ready: boolean;
  state: "ready" | "pending" | "failed" | "skipped";
  detail?: string;
}

const PAGES_POLL_INTERVAL_MS = 15_000;
const PAGES_POLL_TIMEOUT_MS = 15 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function githubJson<T>(
  url: string,
  token: string,
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) {
    throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
  }
  return { status: res.status, data: (await res.json()) as T };
}

async function getPagesDeploymentStatus(
  owner: string,
  repo: string,
  token: string,
  commitSha: string,
): Promise<GithubPagesPublishStatus> {
  const deploymentUrl = `${API_BASE}/repos/${owner}/${repo}/pages/deployments/${commitSha}`;
  const deployment = await githubJson<PagesDeploymentResponse>(deploymentUrl, token);
  if (deployment.status === 200 && deployment.data) {
    const status = deployment.data.status ?? "unknown";
    if (status === "succeed") return { ready: true, state: "ready", detail: status };
    if (
      [
        "deployment_failed",
        "deployment_content_failed",
        "deployment_attempt_error",
        "deployment_lost",
        "deployment_cancelled",
      ].includes(status)
    ) {
      return { ready: false, state: "failed", detail: status };
    }
    return { ready: false, state: "pending", detail: status };
  }

  const siteUrl = `${API_BASE}/repos/${owner}/${repo}/pages`;
  const site = await githubJson<PagesSiteResponse>(siteUrl, token);
  if (site.status === 200 && site.data?.status === "errored") {
    return { ready: false, state: "failed", detail: "pages_site_errored" };
  }

  const latestBuildUrl = `${API_BASE}/repos/${owner}/${repo}/pages/builds/latest`;
  const latestBuild = await githubJson<PagesBuildResponse>(latestBuildUrl, token);
  if (latestBuild.status === 200 && latestBuild.data) {
    const build = latestBuild.data;
    if (build.commit === commitSha && build.status === "built") {
      return { ready: true, state: "ready", detail: "built" };
    }
    if (build.commit === commitSha && build.status === "errored") {
      return {
        ready: false,
        state: "failed",
        detail: build.error?.message ?? "pages_build_errored",
      };
    }
    return {
      ready: false,
      state: "pending",
      detail:
        build.commit === commitSha ? (build.status ?? "building") : "waiting_for_target_build",
    };
  }

  return { ready: false, state: "pending", detail: "pages_status_unavailable" };
}

async function getFileSha(
  owner: string,
  repo: string,
  path: string,
  token: string,
): Promise<string | null> {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as ContentItem;
  return data.sha;
}

function buildDiaryMarkdown(date: string, content: string): string {
  return `---
title: "${date} 猫娘日记"
date: ${date}T23:59:00+08:00
tags: [日记]
slug: diary
---

${content}
`;
}

export async function pushDiaryToGithub(
  date: string,
  content: string,
): Promise<GithubDiaryPushResult | null> {
  const repo = config.githubRepo;
  const token = config.githubToken;
  if (!repo || !token) return null;

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    logger.warn({ repo }, "github: invalid GITHUB_REPO format, expected owner/repo");
    return null;
  }

  const path = `source/_posts/${date}-diary.md`;
  const markdown = buildDiaryMarkdown(date, content);
  const encoded = Buffer.from(markdown, "utf-8").toString("base64");

  const existingSha = await getFileSha(owner, repoName, path, token);

  const body = JSON.stringify({
    message: `日记: ${date}`,
    content: encoded,
    ...(existingSha ? { sha: existingSha } : {}),
  });

  const url = `${API_BASE}/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as PutContentResponse;
  const commitSha = data.commit?.sha;
  if (!commitSha) {
    throw new Error("GitHub PUT diary succeeded but commit sha was missing");
  }

  logger.info({ date, path, commitSha }, "diary pushed to GitHub");
  return { owner, repo: repoName, path, commitSha };
}

export async function waitForGithubPagesPublish(
  pushResult: GithubDiaryPushResult,
): Promise<GithubPagesPublishStatus> {
  const token = config.githubToken;
  if (!token) return { ready: false, state: "skipped", detail: "github_token_missing" };

  const deadline = Date.now() + PAGES_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await getPagesDeploymentStatus(
      pushResult.owner,
      pushResult.repo,
      token,
      pushResult.commitSha,
    );
    if (status.state === "ready" || status.state === "failed") {
      logger.info(
        { commitSha: pushResult.commitSha, state: status.state, detail: status.detail },
        "github pages publish check finished",
      );
      return status;
    }
    logger.info(
      { commitSha: pushResult.commitSha, state: status.state, detail: status.detail },
      "github pages publish still pending",
    );
    await sleep(PAGES_POLL_INTERVAL_MS);
  }

  return { ready: false, state: "pending", detail: "pages_publish_timeout" };
}
