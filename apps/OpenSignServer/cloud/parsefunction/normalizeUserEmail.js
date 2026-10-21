import { accountEmail } from '../../utils/normalizeEmail.js';

export default function normalizeUserEmail(request) {
  const normalized = accountEmail({
    email: request.object.get('email'),
    username: request.object.get('username'),
  });
  if (normalized) request.object.set('normalizedEmail', normalized);
  else request.object.unset('normalizedEmail');
}
