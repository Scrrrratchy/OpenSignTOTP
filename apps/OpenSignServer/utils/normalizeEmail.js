export function normalizeEmail(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/\s/g, '') : '';
}

export function accountEmail(user) {
  return normalizeEmail(user.email || (user.username?.includes('@') ? user.username : ''));
}
