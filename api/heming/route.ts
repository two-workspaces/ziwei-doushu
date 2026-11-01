import { describeChart, plain, rateLimited, readJson, RULES, streamChat } from '../_llm/llm';

const DEFAULT_QUESTION = '请分析两人的合盘：各自性格与相处方式、契合与冲突之处（感情、合作、家庭），以及具体的相处建议。';

export async function POST(req: Request) {
  if (rateLimited(req)) return plain(429, 'Too many AI requests from this address; try again later.');
  const body = await readJson(req);
  let charts: string;
  try { charts = `${describeChart(body?.chartA, '甲方')}\n\n${describeChart(body?.chartB, '乙方')}`; } catch { return plain(400, 'bad chart'); }
  const question = typeof body?.question === 'string' && body.question.trim() ? body.question.slice(0, 2000) : DEFAULT_QUESTION;
  return streamChat(`${RULES}\n这是两人的合盘。\n\n${charts}`, [{ role: 'user', content: question }]);
}
