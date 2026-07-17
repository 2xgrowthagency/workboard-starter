export function isSupportedTaskDirective(value, rawTaskId) {
  if (typeof value !== 'string' || typeof rawTaskId !== 'string' || rawTaskId.length === 0) {
    return false;
  }
  const match = value.match(/^::created-thread\{threadId="([^"\r\n]+)"\}$/);
  return match?.[1] === rawTaskId;
}
