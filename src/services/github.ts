import config from "../configs/env.js";
import { logger } from "../libs/logger.js";

const API_BASE = config.githubApiBase;
const API_VERSION = config.githubApiVersion;

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

interface GitReferenceResponse {
  object?: {
    sha?: string;
  };
}

interface GitCommitResponse {
  sha?: string;
  tree?: {
    sha?: string;
  };
}

interface GitBlobResponse {
  sha?: string;
}

interface GitTreeResponse {
  sha?: string;
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

export interface GithubDiaryImageAsset {
  path: string;
  content: Buffer;
}

const PAGES_POLL_INTERVAL_MS = 15_000;
const PAGES_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const GITHUB_DIARY_BRANCH = "main";

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

async function githubMutation<T>(params: {
  url: string;
  token: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
}): Promise<T> {
  const res = await fetch(params.url, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.body),
  });
  if (!res.ok) {
    throw new Error(`GitHub ${params.method} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
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

async function getBranchHeadCommitSha(
  owner: string,
  repo: string,
  token: string,
): Promise<string | null> {
  const url = `${API_BASE}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(GITHUB_DIARY_BRANCH)}`;
  const { status, data } = await githubJson<GitReferenceResponse>(url, token);
  if (status === 404 || !data?.object?.sha) return null;
  return data.object.sha;
}

async function getCommitTreeSha(
  owner: string,
  repo: string,
  token: string,
  commitSha: string,
): Promise<string> {
  const url = `${API_BASE}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  const { data } = await githubJson<GitCommitResponse>(url, token);
  const treeSha = data?.tree?.sha;
  if (!treeSha) {
    throw new Error(`GitHub commit ${commitSha} missing tree sha`);
  }
  return treeSha;
}

async function createBlob(
  owner: string,
  repo: string,
  token: string,
  content: Buffer | string,
): Promise<string> {
  const data = await githubMutation<GitBlobResponse>({
    url: `${API_BASE}/repos/${owner}/${repo}/git/blobs`,
    token,
    method: "POST",
    body: {
      content:
        typeof content === "string"
          ? Buffer.from(content, "utf-8").toString("base64")
          : content.toString("base64"),
      encoding: "base64",
    },
  });
  if (!data.sha) {
    throw new Error("GitHub blob create succeeded but sha was missing");
  }
  return data.sha;
}

async function createTree(
  owner: string,
  repo: string,
  token: string,
  baseTreeSha: string,
  entries: { path: string; blobSha: string }[],
): Promise<string> {
  const data = await githubMutation<GitTreeResponse>({
    url: `${API_BASE}/repos/${owner}/${repo}/git/trees`,
    token,
    method: "POST",
    body: {
      base_tree: baseTreeSha,
      tree: entries.map((entry) => ({
        path: entry.path,
        mode: "100644",
        type: "blob",
        sha: entry.blobSha,
      })),
    },
  });
  if (!data.sha) {
    throw new Error("GitHub tree create succeeded but sha was missing");
  }
  return data.sha;
}

async function createCommit(
  owner: string,
  repo: string,
  token: string,
  message: string,
  treeSha: string,
  parentCommitSha: string,
): Promise<string> {
  const data = await githubMutation<GitCommitResponse>({
    url: `${API_BASE}/repos/${owner}/${repo}/git/commits`,
    token,
    method: "POST",
    body: {
      message,
      tree: treeSha,
      parents: [parentCommitSha],
    },
  });
  if (!data.sha) {
    throw new Error("GitHub commit create succeeded but sha was missing");
  }
  return data.sha;
}

async function updateBranchHead(
  owner: string,
  repo: string,
  token: string,
  commitSha: string,
): Promise<void> {
  await githubMutation<GitReferenceResponse>({
    url: `${API_BASE}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(GITHUB_DIARY_BRANCH)}`,
    token,
    method: "PATCH",
    body: {
      sha: commitSha,
      force: false,
    },
  });
}

function buildDiaryMarkdownWithImage(
  date: string,
  content: string,
  options?: { indexImage?: string },
): string {
  const body = options?.indexImage ? `![](${options.indexImage})\n\n${content}` : content;
  return `---
title: "${date} 猫娘日记"
date: ${date}T23:59:00+08:00
tags: [日记]
slug: diary
${options?.indexImage ? `index_img: ${options.indexImage}\n` : ""}---

${body}
`;
}

function buildGithubRepoAssetUrl(repoName: string, sourcePath: string): string {
  return `/${repoName}/${sourcePath.replace(/^source\//u, "")}`;
}

export async function pushDiaryToGithub(
  date: string,
  content: string,
  options?: { imageAsset?: GithubDiaryImageAsset },
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
  let indexImage: string | undefined;
  const headCommitSha = await getBranchHeadCommitSha(owner, repoName, token);
  if (!headCommitSha) {
    throw new Error(`GitHub branch ${GITHUB_DIARY_BRANCH} head not found`);
  }
  const baseTreeSha = await getCommitTreeSha(owner, repoName, token, headCommitSha);

  const entries: { path: string; blobSha: string }[] = [];
  if (options?.imageAsset) {
    indexImage = buildGithubRepoAssetUrl(repoName, options.imageAsset.path);
    entries.push({
      path: options.imageAsset.path,
      blobSha: await createBlob(owner, repoName, token, options.imageAsset.content),
    });
  }

  const markdown = buildDiaryMarkdownWithImage(
    date,
    content,
    indexImage ? { indexImage } : undefined,
  );
  entries.push({ path, blobSha: await createBlob(owner, repoName, token, markdown) });

  const treeSha = await createTree(owner, repoName, token, baseTreeSha, entries);
  const commitMessage = options?.imageAsset ? `日记与词云: ${date}` : `日记: ${date}`;
  const commitSha = await createCommit(
    owner,
    repoName,
    token,
    commitMessage,
    treeSha,
    headCommitSha,
  );
  await updateBranchHead(owner, repoName, token, commitSha);

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
