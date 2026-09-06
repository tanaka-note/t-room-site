import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { definitionStatus } from '../../security-worker/src/definition-status.js';
import { cloudflareClient, readState, APPLICATION_PATH, SECURITY_DB, query } from './definition-api.mjs';

export const TITLE = '[ClamAV] 定義更新・監視の確認が必要です';
const MARKER = '<!-- tlain-clamav-monitor -->';
export async function notifyGithub(state, github, repository = 'tanaka-note/t-room-site') {
  const path = `/repos/${repository}/issues`;
  const issues = await github(`${path}?state=all&per_page=100&creator=github-actions%5Bbot%5D`);
  const issue = issues.find(item => item.title === TITLE && item.body?.includes(MARKER));
  if (state === 'healthy' && !issue) return;
  const signature = `<!-- state:${state} -->`;
  if (issue?.body?.includes(signature) && issue.state === (state === 'healthy' ? 'closed' : 'open')) return;
  const body = `${MARKER}\n${signature}\n\n${state === 'healthy' ? '定義更新と監視が復旧しました。' : 'ClamAV定義の更新・監視を確認してください。'}\n\n状態: ${state}\n\n[セキュリティセンター](https://tanaka-note.com/security/)で生成日時・期限・更新結果を確認してください。定義が7日を超えた場合、Downloaderは取得を停止します。\n\n初回設定は downloader-worker/DEFINITION-UPDATES.md を参照してください。`;
  if (issue) {
    await github(`${path}/${issue.number}`, 'PATCH', { body, state: state === 'healthy' ? 'closed' : 'open' });
    await github(`${path}/${issue.number}/comments`, 'POST', { body: state === 'healthy' ? '復旧を確認しました。' : `状態が変わりました: ${state}` });
  } else {
    await github(path, 'POST', { title: TITLE, body, assignees: ['tanaka-note'] });
  }
}

export async function monitor({ api, github, now = Math.floor(Date.now() / 1000) }) {
  let state;
  try {
    api ||= cloudflareClient();
    const row = await readState(api);
    const app = await api(APPLICATION_PATH);
    const matches = Boolean(row?.image && app.configuration.image === row.image && !app.active_rollout_id);
    await query(api, SECURITY_DB, "UPDATE security_definition_updates SET deployment_matches=?,image_checked_at=? WHERE service='downloader'", [matches ? 1 : 0, now]);
    state = definitionStatus({ ...row, deployment_matches: matches ? 1 : 0, image_checked_at: now }, now).state;
  } catch {
    state = process.env.CLOUDFLARE_API_TOKEN ? 'status_unavailable' : 'cloudflare_token_missing';
  }
  await notifyGithub(state, github);
  return state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const github = async (path, method = 'GET', body) => {
    if (!process.env.GITHUB_TOKEN) throw new Error('notification_token_missing');
    const response = await fetch(`https://api.github.com${path}`, { method, headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'tlain-clamav-monitor'
    }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`notification_http_${response.status}`);
    return response.json();
  };
  monitor({ github }).then(state => { console.log(`ClamAV monitor: ${state}`); if (state !== 'healthy') process.exitCode = 1; })
    .catch(() => { console.error('definition_notification_failed'); process.exitCode = 1; });
}
