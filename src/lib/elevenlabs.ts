import { ElevenLabsClient, ElevenLabsError } from '@elevenlabs/elevenlabs-js';
import { requireEnv } from './env.ts';
import { UserError } from './errors.ts';

let client: ElevenLabsClient | null = null;

export function elevenlabs(): ElevenLabsClient {
  client ??= new ElevenLabsClient({ apiKey: requireEnv('ELEVENLABS_API_KEY') });
  return client;
}

/** Turns an ElevenLabs API failure into a message and a fix. Other errors pass through. */
export function explainElevenLabsError(err: unknown): unknown {
  if (!(err instanceof ElevenLabsError)) return err;
  const body = err.body as { detail?: { status?: string; message?: string } | string } | undefined;
  const detail = typeof body?.detail === 'string' ? body.detail : body?.detail?.message;
  const status = typeof body?.detail === 'object' ? body.detail.status : undefined;
  if (status === 'quota_exceeded' || err.statusCode === 402) {
    return new UserError('ElevenLabs refused the request because the credit quota is used up.',
      'Raise the quota for this key on the ElevenLabs API keys page, or wait for next month\'s credits, then try again.');
  }
  if (status === 'missing_permissions') {
    return new UserError(`ElevenLabs refused the request: ${detail}`,
      'On the ElevenLabs API keys page, edit this key and turn on the missing permission. Then try again.');
  }
  if (err.statusCode === 401) {
    return new UserError('ElevenLabs did not accept the API key.',
      'Check ELEVENLABS_API_KEY in .env, and that the key has Speech to Text, Text to Speech and Voices access. Then restart the app.');
  }
  if (err.statusCode === 429) {
    return new UserError('ElevenLabs is limiting requests right now.', 'Wait a minute, then try again.');
  }
  return new UserError(`ElevenLabs returned an error${err.statusCode ? ` (${err.statusCode})` : ''}: ${detail ?? err.message}`,
    'Try again. If it keeps failing, check the ElevenLabs status page.');
}
