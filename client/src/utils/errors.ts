// small helpers for handling request errors

export function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function error_message(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
