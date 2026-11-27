// Nordla Growth - what a log line may say about an error: a short CODE or the error's name, never its message, body or value.
// Engine and provider messages can carry row values or personal data; they are not logged.
export function errorLabel(e) {
  if (e && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(e.code)) return e.code;
  return e && typeof e.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
}
