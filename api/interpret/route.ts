import { cleanMessages, describeChart, plain, rateLimited, readJson, RULES, streamChat } from '../_llm/llm';

export async function POST(req: Request) {
  if (rateLimited(req)) return plain(429, 'Too many AI requests from this address; try again later.');
  const body = await readJson(req);
  const messages = cleanMessages(body?.messages);
  if (!messages) return plain(400, 'bad request');
  let chart: string;
  try { chart = describeChart(body.chart); } catch { return plain(400, 'bad chart'); }
  return streamChat(`${RULES}\n\n${chart}`, messages);
}
