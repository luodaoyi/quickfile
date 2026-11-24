const chunkSize = 4 * 1024 ** 2;

// Wormhole's uploader starts at one request and adapts up to five using p75 duration.
export async function adaptiveUpload(
  tasks,
  upload,
  signal,
  onConcurrency = () => {},
) {
  let concurrency = 1,
    next = 0,
    active = 0,
    durations = [],
    failure;
  onConcurrency(concurrency);
  return new Promise((resolve, reject) => {
    const schedule = () => {
      if (signal.aborted) failure ||= signal.reason;
      if (failure) {
        if (!active) reject(failure);
        return;
      }
      if (durations.length >= concurrency) {
        durations.sort((a, b) => a - b);
        const p75 = durations[Math.ceil(durations.length * 0.75) - 1];
        concurrency = Math.max(
          1,
          Math.min(5, Math.round(concurrency * Math.min(10000 / p75, 2))),
        );
        durations = [];
        onConcurrency(concurrency);
      }
      if (next === tasks.length && !active) {
        resolve();
        return;
      }
      while (!failure && active < concurrency && next < tasks.length) {
        const task = tasks[next++],
          started = performance.now();
        active++;
        Promise.resolve()
          .then(() => upload(task))
          .then(
            () => {
              durations.push(performance.now() - started);
            },
            (err) => {
              failure ||= err;
            },
          )
          .finally(() => {
            active--;
            schedule();
          });
      }
    };
    schedule();
  });
}

export function receivedBytes(file) {
  return (
    file.uploaded +
    (file.ranges || []).reduce((sum, r) => sum + r.end - r.start, 0)
  );
}

export function confirmRange(file, start, end) {
  const ranges = [...(file.ranges || []), { start, end }].sort(
    (a, b) => a.start - b.start,
  );
  file.ranges = [];
  for (const part of ranges) {
    if (part.start <= file.uploaded)
      file.uploaded = Math.max(file.uploaded, part.end);
    else if (file.ranges.length && part.start <= file.ranges.at(-1).end)
      file.ranges.at(-1).end = Math.max(file.ranges.at(-1).end, part.end);
    else file.ranges.push({ ...part });
  }
}

export function uploadTasks(files) {
  const queues = files.map((file, index) => {
    const tasks = [];
    let offset = file.uploaded;
    for (const range of [
      ...(file.ranges || []),
      { start: file.size, end: file.size },
    ]) {
      while (offset < range.start) {
        const end = Math.min(offset + chunkSize, range.start);
        tasks.push({ index, offset, end });
        offset = end;
      }
      offset = range.end;
    }
    return tasks;
  });
  const tasks = [];
  // Round-robin files, then let the shared adaptive window schedule their pieces.
  for (let row = 0; queues.some((q) => row < q.length); row++)
    for (const queue of queues) if (queue[row]) tasks.push(queue[row]);
  return tasks;
}
