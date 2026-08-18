import React from 'react';
import { Redirect, usePathname } from 'expo-router';
import { useAuth } from './AuthContext';
import { log } from '../utils/log';

/**
 * Route guard for the screens that sit outside `(tabs)`.
 *
 * `/recorder` and `/recording/[id]` are root-level routes, so neither the boot
 * gate on `/` nor the tabs layout ever runs for them. Without this, reloading
 * the bundle while one of them is open - or following a `cleanpro://recorder`
 * link - opens the camera on a signed-out app.
 *
 * The screen is only mounted once there is a session, so its permission
 * prompts and requests never fire for a signed-out user.
 */
export function RequireAuth({ children }) {
  const { status } = useAuth();
  const pathname = usePathname();

  if (status === 'restoring') return null;
  if (status !== 'authenticated') {
    log('auth', `no session at ${pathname} - sending to /login`);
    return <Redirect href="/login" />;
  }
  return children;
}
