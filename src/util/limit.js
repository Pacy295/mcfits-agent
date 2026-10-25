/** 有限并发 map，保持顺序 */
export async function mapLimit(items, limit, fn) {
  const arr = [...items];
  const out = new Array(arr.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= arr.length) return;
      try {
        out[i] = { ok: true, value: await fn(arr[i], i) };
      } catch (err) {
        out[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}
