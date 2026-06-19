import { methodNotAllowed } from '../_lib/http.js';
import { requireLauncherArtifactAccessAndSend } from '../_lib/artifact-delivery.js';

const PATH_TO_TYPE = {
  '/jar': 'client',
  '/jre': 'jre',
  '/assets': 'assets',
  '/fade-jar': 'fade-client'
};

function getPathSuffix(req) {
  try {
    const pathname = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`).pathname;
    const match = pathname.match(/\/api\/launcher(\/[^/?#]+)/i);
    return match?.[1]?.toLowerCase() || '';
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res);
  }

  const suffix = getPathSuffix(req);
  const artifactType = PATH_TO_TYPE[suffix];
  if (!artifactType) {
    return res.status(404).json({ ok: false, error: 'Launcher artifact endpoint not found.' });
  }

  return requireLauncherArtifactAccessAndSend(req, res, artifactType);
}
