import loginHandler from './_launcher/login.js';
import manifestHandler from './_launcher/manifest.js';
import heartbeatHandler from './_launcher/heartbeat.js';
import verifySessionHandler from './_launcher/verify-session.js';
import launchTokenHandler from './_launcher/launch-token.js';
import artifactHandler from './_launcher/artifact.js';
import securityEventHandler from './_launcher/security-event.js';

function getPathname(req) {
  try {
    return new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return req.url || '/';
  }
}

export default async function handler(req, res) {
  const pathname = getPathname(req);

  if (pathname.includes('/login')) {
    return loginHandler(req, res);
  }

  if (pathname.includes('/manifest')) {
    return manifestHandler(req, res);
  }

  if (pathname.includes('/heartbeat')) {
    return heartbeatHandler(req, res);
  }

  if (pathname.includes('/verify-session')) {
    return verifySessionHandler(req, res);
  }

  if (pathname.includes('/launch-token')) {
    return launchTokenHandler(req, res);
  }

  if (pathname.includes('/security-event')) {
    return securityEventHandler(req, res);
  }

  if (
    pathname.includes('/artifact') || 
    pathname.includes('/jar') ||
    pathname.includes('/fade-jar') ||
    pathname.includes('/jre') || 
    pathname.includes('/assets')) {
    return artifactHandler(req, res);
  }

  return res.status(404).json({
    ok: false,
    error: 'Launcher endpoint not found.'
  });
}
