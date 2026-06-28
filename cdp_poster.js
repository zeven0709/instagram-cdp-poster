#!/usr/bin/env node
/**
 * CDP-based Instagram Auto Poster
 * Uses chrome-remote-interface (Chrome DevTools Protocol)
 * instead of Selenium/undetected-chromedriver.
 *
 * Usage:
 *   node cdp_poster.js <post_url> [--comment "your comment text"]
 *   node cdp_poster.js                          (default post + fallback comment)
 *   node cdp_poster.js <post_url> --comment "Aku bisa bantu joki tugas kak, DM ya!"
 *
 * If --comment is provided, skips LLM generation and uses that text directly.
 */
const CDP = require('chrome-remote-interface');

// ─── Config ─────────────────────────────────────────────
const PORT = 9222;
const USERNAME = 'nugasingenz';
const IG_BASE = 'https://www.instagram.com';
const DEFAULT_POST = 'https://www.instagram.com/unpri_medan/p/DR3J4eLk6Wo/';

// Parse args: node cdp_poster.js <post_url> [--comment "text"]
const args = process.argv.slice(2);
let TARGET_POST = DEFAULT_POST;
let CUSTOM_COMMENT = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--comment') {
    CUSTOM_COMMENT = args[++i] || null;
  } else if (args[i].startsWith('http')) {
    TARGET_POST = args[i];
  }
}

// ─── CDP Helpers ────────────────────────────────────────
function evaluate(Runtime, expression, awaitPromise = false) {
  // Auto-wrap arrow/async/function definitions as IIFE so they execute
  const trimmed = expression.trim();
  let wrapped;
  if (trimmed.startsWith('() =>') || trimmed.startsWith('async ()')) {
    wrapped = `(${trimmed})()`;
  } else if (trimmed.startsWith('function') || trimmed.startsWith('async function')) {
    wrapped = `(${trimmed})()`;
  } else {
    wrapped = trimmed;
  }
  return Runtime.evaluate({
    expression: wrapped,
    returnByValue: true,
    awaitPromise,
  }).then(r => {
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.text ||
                  r.exceptionDetails.exception?.description ||
                  'Unknown error';
      throw new Error(msg);
    }
    // Handle both undefined and null/valid values
    if (r.result.type === 'undefined') return undefined;
    return r.result.value;
  });
}

function rawEval(Runtime, expression) {
  return Runtime.evaluate({
    expression,
    returnByValue: false,
    awaitPromise: false,
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForPage(Page, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    Page.loadEventFired(() => {
      clearTimeout(timer);
      resolve('loaded');
    });
  });
}

// ─── LLM Call (SSE streaming via fetch) ─────────────────
async function callLLM(systemPrompt, userPrompt) {
  const resp = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
      stream: true,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!resp.ok) {
    throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  }

  let content = '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const chunk = trimmed.slice(6);
      if (chunk === '[DONE]') break;
      try {
        const obj = JSON.parse(chunk);
        const deltaContent = obj.choices?.[0]?.delta?.content;
        // DeepSeek can put content in "reasoning" field
        const reasoning = obj.choices?.[0]?.delta?.reasoning;
        if (deltaContent) content += deltaContent;
        else if (reasoning) content += reasoning;
      } catch {
        // skip malformed chunks
      }
    }
  }
  return content;
}

async function generateComment(caption, account = '') {
  const systemPrompt = `Kamu asisten marketing Instagram untuk jasa bantuan tugas akademik, joki tugas (makalah, laporan, PPT), dan service laptop/install ulang Windows untuk mahasiswa Medan.
Tugasmu: generate 3 opsi komentar yang NATURAL, ramah, seperti teman mahasiswa, cocok diposting di akun kampus/universitas.

PRIORITAS UTAMA: Tawarkan jasa joki tugas, bantuan akademik, atau service laptop secara subtle/natural.
JANGAN hard selling / template sama tiap posting.
Variasikan: pembukaan, gaya bahasa, struktur kalimat.

Format response HARUS JSON dengan key "options" yang berisi array of strings.`;

  const userPrompt = `Buat 3 opsi komentar natural untuk posting ini:

Caption: ${caption.slice(0, 500)}
Akun: ${account || 'akun kampus'}

PRIORITASKAN menawarkan jasa:
1. Joki tugas akademik (makalah, laporan praktikum, PPT, revisi)
2. Bantuan teknis tugas kuliah
3. Service laptop / install ulang Windows (visit area kampus Medan)

Gaya: seperti mahasiswa lokal, ramah, tidak spam. Variasikan setiap opsi.`;

  try {
    const raw = await callLLM(systemPrompt, userPrompt);
    // Parse JSON from response
    let cleaned = raw;
    if (cleaned.includes('```')) {
      cleaned = cleaned.split('```')[1];
      if (cleaned.startsWith('json')) cleaned = cleaned.slice(4);
    }
    cleaned = cleaned.trim();
    if (!cleaned.startsWith('{')) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
    }
    const parsed = JSON.parse(cleaned);
    const options = (parsed.options || []).slice(0, 3).map(o => o.slice(0, 250));
    if (options.length === 0) return null;
    // Pick one randomly
    return options[Math.floor(Math.random() * options.length)];
  } catch (err) {
    console.error(`    ⚠️ LLM error: ${err.message}`);
    return null;
  }
}

// ─── Dismiss Instagram popups ───────────────────────────
async function dismissModals(Runtime) {
  const script = `
    document.querySelectorAll('[role="dialog"], [role="presentation"]').forEach(dlg => {
      // Click all buttons with dismiss text
      dlg.querySelectorAll('button, div[role="button"], span[role="button"]').forEach(b => {
        const txt = (b.textContent || '').trim().toLowerCase();
        if (['not now', 'not now!', 'cancel', 'close', 'x', 'tidak sekarang'].includes(txt)) {
          b.click();
        }
      });
      // Click all SVG close buttons
      dlg.querySelectorAll('svg[aria-label="Close"], svg[aria-label="Tutup"]').forEach(svg => {
        svg.closest('div[role="button"], button')?.click();
      });
    });
    // Also try the specific 'Not Now' button
    const notNow = document.querySelector('div[role="button"]:not(._a9_1)');
    if (notNow && notNow.textContent.trim().toLowerCase() === 'not now') {
      notNow.click();
    }
  `;
  try { await rawEval(Runtime, script); } catch {}
  await sleep(1500);
}

// ─── Check existing comment ─────────────────────────────
// Positive check: look for @nugasingenz links inside the main post section
// or inside comment menuitems. Ignores sidebar/navbar profile links.
async function checkOurComment(Runtime) {
  return evaluate(Runtime, `
    () => {
      const username = ${JSON.stringify(USERNAME)};

      // Method 1: Check inside comment items (traditional layout)
      const commentItems = document.querySelectorAll(
        'div[role="menuitem"]'
      );
      for (const item of commentItems) {
        if (item.textContent.includes('@' + username)) return true;
        const links = item.querySelectorAll('a[href*="/' + username + '/"]');
        if (links.length > 0) return true;
      }

      // Method 2: Check links inside the main section (newer layout)
      const sections = document.querySelectorAll('section');
      for (const section of sections) {
        const links = section.querySelectorAll('a[href*="/' + username + '/"]');
        if (links.length > 0) return true;
        if (section.textContent.includes('@' + username)) return true;
      }

      // Method 3: Check inside the post article element
      const articles = document.querySelectorAll('article');
      for (const article of articles) {
        const links = article.querySelectorAll('a[href*="/' + username + '/"]');
        if (links.length > 0) return true;
      }

      return false;
    }
  `);
}

// ─── Post comment via JS injection ──────────────────────
async function postComment(Runtime, text) {
  const jsText = JSON.stringify(text);
  return evaluate(Runtime, `
    async () => {
      // Blur active element
      document.activeElement?.blur();
      await new Promise(r => setTimeout(r, 500));

      // Find textarea — try multiple selectors
      const tb = document.querySelector('textarea[aria-label*="Add a comment" i]') ||
                 document.querySelector('textarea[aria-label*="comment" i]') ||
                 document.querySelector('textarea[aria-label*="Tambah" i]') ||
                 document.querySelector('div[role="textbox"][aria-label*="comment" i]') ||
                 document.querySelector('form textarea');

      if (!tb) return 'no_textbox';

      // Focus
      tb.focus();
      tb.click();
      await new Promise(r => setTimeout(r, 500));

      // --- React-safe value setter ---
      // Try native setter first
      try {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        setter.call(tb, ${jsText});
      } catch {
        tb.value = ${jsText};
      }

      tb.dispatchEvent(new Event('input', { bubbles: true }));
      tb.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 500));

      // Submit via Enter key
      tb.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
      await new Promise(r => setTimeout(r, 1000));

      // Also try clicking Post button
      const allBtns = document.querySelectorAll('div[role="button"]');
      for (const b of allBtns) {
        const txt = b.textContent.trim();
        if ((txt === 'Post' || txt === 'Kirim') && b.offsetHeight > 0) {
          b.click();
          return 'clicked_post';
        }
      }

      return 'submitted_enter';
    }
  `, true);
}

// ─── Main ───────────────────────────────────────────────
async function main() {
  console.log('='.repeat(55));
  console.log('  CDP IG POSTER — Node.js + chrome-remote-interface');
  console.log('  ' + new Date().toISOString());
  console.log('='.repeat(55));

  // 1. Connect to Chrome
  console.log('\n[2] Connecting to Chrome (CDP port 9222)...');
  let client;
  try {
    client = await CDP({ host: 'localhost', port: PORT });
  } catch (err) {
    console.error('    ❌ FAILED. Is Chrome running with --remote-debugging-port=9222?');
    console.error('');
    console.error('    Run this command (close all Chrome windows first):');
    console.error('    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\\temp\\chrome-debug"');
    console.error('');
    console.error('    Then verify at: http://localhost:9222/json');
    process.exit(1);
  }
  console.log('    ✅ Connected!');

  const { Network, Page, Runtime } = client;
  await Network.enable();
  await Page.enable();
  await Runtime.enable();

  try {
    // 3. Navigate to Instagram (already logged in via persistent profile)
    console.log('\n[3] Navigating to Instagram...');
    await Page.navigate({ url: IG_BASE });
    await waitForPage(Page);
    await sleep(5000);

    // Verify login
    const currentUrl = await evaluate(Runtime, '() => window.location.href');
    console.log(`    URL: ${currentUrl}`);

    if (currentUrl.includes('login') || currentUrl.includes('accounts')) {
      console.error('    ❌ NOT LOGGED IN — Open Chrome manually and log in to Instagram first');
      console.error('    The persistent profile at --user-data-dir needs a one-time manual login');
      process.exit(1);
    }
    console.log('    ✅ Logged in as @' + USERNAME);

    // Dismiss any popups
    await dismissModals(Runtime);

    // 5. Navigate to target post
    console.log(`\n[5] Opening post: ${TARGET_POST}`);
    await Page.navigate({ url: TARGET_POST });
    await waitForPage(Page);
    await sleep(5000);
    await dismissModals(Runtime);

    // 6. Check for existing comment
    console.log(`\n[6] Checking for @${USERNAME} comment...`);
    const hasCommented = await checkOurComment(Runtime);
    if (hasCommented) {
      console.log(`    ✅ Comment by @${USERNAME} already exists!`);
      console.log('    Skipping.');
      return;
    }
    console.log('    @${USERNAME} not found — will post new comment');

    // 7. Extract post caption (for reference)
    console.log('\n[7] Post caption...');
    const caption = await evaluate(Runtime, `
      () => {
        const selectors = [
          'h1',
          'div._a9zs',
          'div[style*="flex"] div[dir="auto"]',
          'article div[role="button"] ~ div span',
          'div[data-testid="post-comment-root"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent.trim().length > 5) {
            return el.textContent.trim().slice(0, 500);
          }
        }
        return '';
      }
    `);
    console.log(`    Caption: "${caption.slice(0, 120)}..."`);

    // 8. Get comment text
    console.log('\n[8] Comment...');
    let comment;
    if (CUSTOM_COMMENT) {
      // Use user-provided comment (from Hermes agent)
      comment = CUSTOM_COMMENT;
      console.log('    Using custom comment from Hermes');
    } else {
      // Fallback comment
      comment = 'Mantap banget ini kak! Kalau ada yang butuh bantuan joki tugas (makalah, PPT, laporan) atau service laptop area Medan, aku bisa bantu. DM aja ya 🙌';
      console.log('    Using fallback comment');
    }
    console.log(`    Comment: "${comment.slice(0, 150)}..."`);

    // 9. Post comment
    console.log('\n[9] Posting comment...');
    const postResult = await postComment(Runtime, comment);
    console.log(`    Result: ${postResult}`);
    await sleep(3000);

    // 10. Verify comment was posted
    console.log('\n[10] Verifying...');
    await Page.reload();
    await waitForPage(Page);
    await sleep(5000);
    await dismissModals(Runtime);

    const verified = await checkOurComment(Runtime);
    if (verified) {
      console.log('    ✅✅ VERIFIED: Comment posted successfully!');
    } else {
      console.log('    ⚠️  Comment may not have been posted (check manually)');
    }

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    console.error(err.stack?.split('\n').slice(0, 5).join('\n'));
  } finally {
    console.log('\n' + '='.repeat(55));
    console.log('Done.');
    if (client) client.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
