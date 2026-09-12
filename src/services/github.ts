import config from "../configs/env.js";
import { setTimeout as sleep } from "node:timers/promises";
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

interface GithubDependencies {
  fetch: typeof fetch;
  now: () => number;
  sleep: (milliseconds: number, abortSignal?: AbortSignal) => Promise<void>;
  token: string;
  repo: string;
  apiBase: string;
  apiVersion: string;
  pagesPollIntervalMs: number;
  pagesPollTimeoutMs: number;
}

const productionDependencies: GithubDependencies = {
  fetch: globalThis.fetch,
  now: Date.now,
  sleep: (ms, abortSignal) =>
    sleep(ms, undefined, { ref: false, signal: abortSignal }).then(() => undefined),
  token: config.githubToken,
  repo: config.githubRepo,
  apiBase: API_BASE,
  apiVersion: API_VERSION,
  pagesPollIntervalMs: 15_000,
  pagesPollTimeoutMs: 15 * 60 * 1000,
};
const GITHUB_DIARY_BRANCH = "main";

async function githubJson<T>(
  url: string,
  token: string,
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<{ status: number; data: T | null }> {
  const res = await dependencies.fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": dependencies.apiVersion,
    },
    ...(abortSignal ? { signal: abortSignal } : {}),
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
  dependencies: GithubDependencies;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const res = await params.dependencies.fetch(params.url, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": params.dependencies.apiVersion,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.body),
    ...(params.abortSignal ? { signal: params.abortSignal } : {}),
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
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<GithubPagesPublishStatus> {
  const deploymentUrl = `${dependencies.apiBase}/repos/${owner}/${repo}/pages/deployments/${commitSha}`;
  const deployment = await githubJson<PagesDeploymentResponse>(
    deploymentUrl,
    token,
    dependencies,
    abortSignal,
  );
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

  const siteUrl = `${dependencies.apiBase}/repos/${owner}/${repo}/pages`;
  const site = await githubJson<PagesSiteResponse>(siteUrl, token, dependencies, abortSignal);
  if (site.status === 200 && site.data?.status === "errored") {
    return { ready: false, state: "failed", detail: "pages_site_errored" };
  }

  const latestBuildUrl = `${dependencies.apiBase}/repos/${owner}/${repo}/pages/builds/latest`;
  const latestBuild = await githubJson<PagesBuildResponse>(
    latestBuildUrl,
    token,
    dependencies,
    abortSignal,
  );
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
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const url = `${dependencies.apiBase}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(GITHUB_DIARY_BRANCH)}`;
  const { status, data } = await githubJson<GitReferenceResponse>(
    url,
    token,
    dependencies,
    abortSignal,
  );
  if (status === 404 || !data?.object?.sha) return null;
  return data.object.sha;
}

async function getCommitTreeSha(
  owner: string,
  repo: string,
  token: string,
  commitSha: string,
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<string> {
  const url = `${dependencies.apiBase}/repos/${owner}/${repo}/git/commits/${commitSha}`;
  const { data } = await githubJson<GitCommitResponse>(url, token, dependencies, abortSignal);
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
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<string> {
  const data = await githubMutation<GitBlobResponse>({
    url: `${dependencies.apiBase}/repos/${owner}/${repo}/git/blobs`,
    token,
    method: "POST",
    body: {
      content:
        typeof content === "string"
          ? Buffer.from(content, "utf-8").toString("base64")
          : content.toString("base64"),
      encoding: "base64",
    },
    dependencies,
    ...(abortSignal ? { abortSignal } : {}),
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
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<string> {
  const data = await githubMutation<GitTreeResponse>({
    url: `${dependencies.apiBase}/repos/${owner}/${repo}/git/trees`,
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
    dependencies,
    ...(abortSignal ? { abortSignal } : {}),
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
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<string> {
  const data = await githubMutation<GitCommitResponse>({
    url: `${dependencies.apiBase}/repos/${owner}/${repo}/git/commits`,
    token,
    method: "POST",
    body: {
      message,
      tree: treeSha,
      parents: [parentCommitSha],
    },
    dependencies,
    ...(abortSignal ? { abortSignal } : {}),
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
  dependencies: GithubDependencies,
  abortSignal?: AbortSignal,
): Promise<void> {
  await githubMutation<GitReferenceResponse>({
    url: `${dependencies.apiBase}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(GITHUB_DIARY_BRANCH)}`,
    token,
    method: "PATCH",
    body: {
      sha: commitSha,
      force: false,
    },
    dependencies,
    ...(abortSignal ? { abortSignal } : {}),
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

function buildGithubRepoAssetUrl(_repoName: string, sourcePath: string): string {
  return `/${sourcePath.replace(/^source\//u, "")}`;
}

async function pushDiaryToGithubWithDependencies(
  date: string,
  content: string,
  options?: { imageAsset?: GithubDiaryImageAsset },
  dependencies: GithubDependencies = productionDependencies,
  abortSignal?: AbortSignal,
): Promise<GithubDiaryPushResult | null> {
  abortSignal?.throwIfAborted();
  const repo = dependencies.repo;
  const token = dependencies.token;
  if (!repo || !token) return null;

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    logger.warn({ repo }, "github: invalid GITHUB_REPO format, expected owner/repo");
    return null;
  }

  const path = `source/_posts/${date}-diary.md`;
  let indexImage: string | undefined;
  const headCommitSha = await getBranchHeadCommitSha(
    owner,
    repoName,
    token,
    dependencies,
    abortSignal,
  );
  if (!headCommitSha) {
    throw new Error(`GitHub branch ${GITHUB_DIARY_BRANCH} head not found`);
  }
  const baseTreeSha = await getCommitTreeSha(
    owner,
    repoName,
    token,
    headCommitSha,
    dependencies,
    abortSignal,
  );

  const entries: { path: string; blobSha: string }[] = [];
  if (options?.imageAsset) {
    indexImage = buildGithubRepoAssetUrl(repoName, options.imageAsset.path);
    entries.push({
      path: options.imageAsset.path,
      blobSha: await createBlob(
        owner,
        repoName,
        token,
        options.imageAsset.content,
        dependencies,
        abortSignal,
      ),
    });
  }

  const markdown = buildDiaryMarkdownWithImage(
    date,
    content,
    indexImage ? { indexImage } : undefined,
  );
  entries.push({
    path,
    blobSha: await createBlob(owner, repoName, token, markdown, dependencies, abortSignal),
  });

  const treeSha = await createTree(
    owner,
    repoName,
    token,
    baseTreeSha,
    entries,
    dependencies,
    abortSignal,
  );
  const commitMessage = options?.imageAsset ? `日记与词云: ${date}` : `日记: ${date}`;
  const commitSha = await createCommit(
    owner,
    repoName,
    token,
    commitMessage,
    treeSha,
    headCommitSha,
    dependencies,
    abortSignal,
  );
  await updateBranchHead(owner, repoName, token, commitSha, dependencies, abortSignal);

  logger.info({ date, path, commitSha }, "diary pushed to GitHub");
  return { owner, repo: repoName, path, commitSha };
}

async function waitForGithubPagesPublishWithDependencies(
  pushResult: GithubDiaryPushResult,
  dependencies: GithubDependencies = productionDependencies,
  abortSignal?: AbortSignal,
): Promise<GithubPagesPublishStatus> {
  const token = dependencies.token;
  if (!token) return { ready: false, state: "skipped", detail: "github_token_missing" };

  const deadline = dependencies.now() + dependencies.pagesPollTimeoutMs;
  while (dependencies.now() < deadline) {
    abortSignal?.throwIfAborted();
    const status = await getPagesDeploymentStatus(
      pushResult.owner,
      pushResult.repo,
      token,
      pushResult.commitSha,
      dependencies,
      abortSignal,
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
    await dependencies.sleep(dependencies.pagesPollIntervalMs, abortSignal);
  }

  return { ready: false, state: "pending", detail: "pages_publish_timeout" };
}

export function createGithubService(overrides: Partial<GithubDependencies> = {}) {
  const dependencies = { ...productionDependencies, ...overrides };
  return {
    pushDiaryToGithub: (
      date: string,
      content: string,
      options?: { imageAsset?: GithubDiaryImageAsset },
      abortSignal?: AbortSignal,
    ) => pushDiaryToGithubWithDependencies(date, content, options, dependencies, abortSignal),
    waitForGithubPagesPublish: (pushResult: GithubDiaryPushResult, abortSignal?: AbortSignal) =>
      waitForGithubPagesPublishWithDependencies(pushResult, dependencies, abortSignal),
  };
}

export const { pushDiaryToGithub, waitForGithubPagesPublish } = createGithubService();
