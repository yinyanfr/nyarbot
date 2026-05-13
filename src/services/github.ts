import config from "../configs/env.js";
import { logger } from "../libs/logger.js";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

interface ContentItem {
  sha: string;
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

export async function pushDiaryToGithub(date: string, content: string): Promise<void> {
  const repo = config.githubRepo;
  const token = config.githubToken;
  if (!repo || !token) return;

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) {
    logger.warn({ repo }, "github: invalid GITHUB_REPO format, expected owner/repo");
    return;
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

  logger.info({ date, path }, "diary pushed to GitHub");
}
