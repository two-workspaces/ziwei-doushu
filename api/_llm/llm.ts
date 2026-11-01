// The open-source repo ships the charting engine and UI but not the AI routes
// (/api/interpret, /api/heming). These are a minimal OpenAI-compatible stand-in:
// the browser builds the prompts, this adds the chart and streams the answer
// back in the shape the UI reads (`data: {"delta":{"text":…}}` … `data: [DONE]`).
import type { ZiweiChart } from '@/lib/ziwei/types';

const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

export const MAX_BODY = 200_000; // two charts plus a conversation fit well inside this
const MAX_MESSAGES = 40;
const MAX_CONTENT = 12_000;

export type Msg = { role: 'user' | 'assistant'; content: string };

export function cleanMessages(raw: unknown): Msg[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out: Msg[] = [];
  for (const m of raw) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null;
    out.push({ role: m.role, content: m.content.slice(0, MAX_CONTENT) });
  }
  return out;
}

const s = (v: unknown) => String(v ?? '').slice(0, 40);

/** The chart as compact text: the model reads it, it never re-derives it. */
export function describeChart(c: ZiweiChart, label = '命主'): string {
  if (!c || !Array.isArray(c.palaces) || c.palaces.length > 12) throw new Error('bad chart');
  const b = c.birthInfo ?? ({} as ZiweiChart['birthInfo']);
  const l = c.lunarInfo ?? ({} as ZiweiChart['lunarInfo']);
  const lines = [
    `【${label}】${b.gender === 'female' ? '女' : '男'}${c.yinYangGender ? `（${s(c.yinYangGender)}）` : ''}，虚岁 ${Number(c.currentAge) || '?'}`,
    `公历 ${Number(b.year)}-${Number(b.month)}-${Number(b.day)} ${BRANCHES[Number(b.hour)] ?? '?'}时；农历 ${Number(l.lunarYear)}年${l.isLeapMonth ? '闰' : ''}${Math.abs(Number(l.lunarMonth))}月${Number(l.lunarDay)}日`,
    l.fourPillars ? `四柱：${l.fourPillars.map(s).join(' ')}` : '',
    `五行局：${s(c.wuxingJuName)}；命主星：${s(c.mingZhu)}；身主星：${s(c.shenZhu)}`,
    '十二宫：',
  ];
  for (const p of c.palaces) {
    const stars = (p.stars ?? []).slice(0, 40)
      .map((x) => `${s(x.name)}${x.brightnessRaw ? `(${s(x.brightnessRaw)})` : ''}${x.siHua ? `化${s(x.siHua)}` : ''}`)
      .join('、');
    const tags = [p.isMingGong && '命宫', p.isShenGong && '身宫', p.isCurrentDaXian && '当前大限'].filter(Boolean).join('、');
    const self = (p.selfSihua ?? []).slice(0, 4).map((x) => `${s(x.starName)}自化${s(x.siHua)}`).join('、');
    lines.push(
      `- ${STEMS[Number(p.stem)] ?? ''}${BRANCHES[Number(p.branch)] ?? ''} ${s(p.name)}${tags ? `［${tags}］` : ''}` +
        `${p.daXianAge ? ` 大限${Number(p.daXianAge[0])}-${Number(p.daXianAge[1])}岁` : ''}：` +
        `${stars || '无星'}${p.isEmpty && p.borrowedStars?.length ? `；空宫借${s(p.borrowedFromName)}：${p.borrowedStars.slice(0, 6).map(s).join('、')}` : ''}` +
        `${self ? `；${self}` : ''}`,
    );
  }
  const dx = c.daXians?.[Number(c.currentDaXianIndex)];
  if (dx?.siHua) {
    lines.push(`当前大限 ${Number(dx.startAge)}-${Number(dx.endAge)}岁（${s(dx.palaceName)}，${s(dx.siHua.stemName)}干）四化：${s(dx.siHua.lu)}化禄、${s(dx.siHua.quan)}化权、${s(dx.siHua.ke)}化科、${s(dx.siHua.ji)}化忌`);
  }
  return lines.filter(Boolean).join('\n');
}

export const RULES = `你是精通倪海厦《天纪》紫微斗数体系的老师。命盘由排盘引擎算出，以下面给出的为准，不要自行重排或改动星曜。
解读时：依据倪师体系，说明依据（星曜亮度、四化、宫位、三方四正、大限流年）；语言平实，结论具体，给出可操作的建议；
不确定的就说不确定，不要编造古籍原文；涉及健康、法律、投资等重大决定只作参考，并提醒咨询专业人士。用户用什么语言提问就用什么语言回答。`;

// ponytail: in-memory per-IP window, one replica; move to Redis if the service is scaled out.
const hits = new Map<string, number[]>();
export function rateLimited(req: Request): boolean {
  const limit = Number(process.env.AI_REQUESTS_PER_HOUR ?? 30);
  if (!limit) return false;
  const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',').pop()?.trim() ?? 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= limit) return true;
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  return false;
}

export async function readJson(req: Request): Promise<any | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Streams an OpenAI-compatible chat completion as the UI's SSE shape. */
export async function streamChat(system: string, messages: Msg[]): Promise<Response> {
  const key = process.env.AI_API_KEY;
  if (!key) return plain(503, 'AI_API_KEY is not set: charts work, AI readings need a key (see the template README).');
  const base = (process.env.AI_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const upstream = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.AI_MODEL || 'deepseek-flash',
      stream: true,
      max_tokens: Number(process.env.AI_MAX_TOKENS ?? 4096),
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  }).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    console.error('ai: upstream', upstream?.status, await upstream?.text().catch(() => ''));
    return plain(502, 'The AI provider refused the request; check AI_BASE_URL, AI_MODEL and AI_API_KEY.');
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reader = upstream.body.getReader();
  const body = new ReadableStream({
    async start(ctrl) {
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const text = JSON.parse(data).choices?.[0]?.delta?.content;
              if (text) ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ delta: { text } })}\n\n`));
            } catch { /* keep-alive or partial line */ }
          }
        }
      } catch (e) {
        console.error('ai: stream', e);
      }
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' } });
}
