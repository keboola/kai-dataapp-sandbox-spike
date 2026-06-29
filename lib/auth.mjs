// Bearer-token guard. Real enforcement is wired in Task 5; for now allow all.
export function bearerAuth(_expected) {
  return (_req, _res, next) => next();
}
