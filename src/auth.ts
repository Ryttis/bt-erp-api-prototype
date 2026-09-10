import { timingSafeEqual } from 'node:crypto';

/** Exact Bearer-token comparison with constant-time equality for equal-length values. */
export function isAuthorizedServiceRequest(authorization: string | undefined, serviceToken: string): boolean {
  const prefix = 'Bearer ';
  if (!authorization?.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const expected = Buffer.from(serviceToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
