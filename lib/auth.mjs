export function bearerAuth(expected) {
  return (req, res, next) => {
    if (!expected) return next();
    if (req.path === '/health' || req.path === '/') return next();
    if (req.get('authorization') === `Bearer ${expected}`) return next();
    return res.status(401).json({ error: 'unauthorized' });
  };
}
