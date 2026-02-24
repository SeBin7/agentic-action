import test from 'node:test';
import assert from 'node:assert/strict';
import { extractRepositoryMatches, normalizeGitHubUrl } from '../src/pipeline/extract_repo.js';

test('normalizeGitHubUrl handles trailing paths and .git suffix', () => {
  const normalized = normalizeGitHubUrl('https://github.com/Owner/Repo.git/issues/12?x=1');
  assert.deepEqual(normalized, {
    repoId: 'owner/repo',
    repoUrl: 'https://github.com/owner/repo'
  });
});

test('extractRepositoryMatches dedupes repeated references', () => {
  const text = [
    'check https://github.com/vercel/next.js,',
    'also https://github.com/Vercel/Next.js/issues/1',
    'and https://github.com/denoland/deno.'
  ].join(' ');

  const matches = extractRepositoryMatches(text);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0], {
    repoId: 'vercel/next.js',
    repoUrl: 'https://github.com/vercel/next.js'
  });
  assert.deepEqual(matches[1], {
    repoId: 'denoland/deno',
    repoUrl: 'https://github.com/denoland/deno'
  });
});

test('extractRepositoryMatches ignores non-github urls', () => {
  const matches = extractRepositoryMatches('https://example.com/project');
  assert.equal(matches.length, 0);
});
