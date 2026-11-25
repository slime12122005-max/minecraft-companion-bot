import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callConversationService(lsAddr, csrf, method, body) {
  const res = await fetch(`http://${lsAddr}/product.v1.ConversationService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-antigravity-csrf-token': csrf,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json().catch(() => ({}));
}

async function runWorker(convId) {
  const lsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  if (!convId || !lsAddr || !csrf) return;

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const data = await callConversationService(lsAddr, csrf, 'GetConversation', {
        conversationId: convId,
      });
      if (data?.state?.runState === 'RUN_STATE_IDLE') {
        break;
      }
    } catch {
      return;
    }
    await sleep(1500);
  }

  await sleep(800);
  try {
    await callConversationService(lsAddr, csrf, 'DeleteConversation', {
      conversationId: convId,
    });
  } catch {}
}

async function main() {
  const args = process.argv.slice(2);
  const isDetach = args.includes('--detach');
  const isWorker = args.includes('--worker');
  const positionalId = args.find((a) => !a.startsWith('--'));
  const convId = String(positionalId || process.env.ANTIGRAVITY_CONVERSATION_ID || '').trim();
  const lsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const csrf = String(process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();

  if (isWorker) {
    await runWorker(convId);
    return;
  }

  if (isDetach) {
    if (!convId || !lsAddr || !csrf) return;
    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [selfPath, '--worker', convId], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref?.();
  }
}

main().catch(() => {});
