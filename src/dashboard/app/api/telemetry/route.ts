import { connection } from 'next/server';
import { readTelemetry } from '@/lib/read';

// With Cache Components a GET handler is prerendered unless it touches request-time data.
// This one must read the files on every request, so opt in explicitly.
export async function GET() {
  await connection();
  const data = await readTelemetry();
  return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
}
