import type { ApifyLike } from '../lib/providers/apify.ts';

/**
 * A spy that records the two arguments `.start()` receives.
 *
 * This exists because of a specific failure. The Apify result caps were built
 * correctly, documented carefully, asserted by a passing test, and passed as
 * the FIRST argument, where the platform discards them. The test examined the
 * object our own code had just built, so it confirmed the intent rather than
 * the behaviour and stayed green while the cap reached nobody.
 *
 * Injecting the client rather than stubbing the network also means a test can
 * never spend from the shared cohort account by accident. `apify-client` uses
 * axios, so stubbing global fetch does not intercept it: a test written that
 * way silently makes real calls.
 */
export type ApifySpy = ApifyLike & {
  startCalls: { actorId: string; input: any; options: any }[];
  lastStart: () => { actorId: string; input: any; options: any };
  aborted: string[];
};

export function apifySpy(opts: {
  items?: Record<string, unknown>[];
  usageUsd?: number;
  status?: string;
  failStartWith?: { statusCode: number; times?: number };
} = {}): ApifySpy {
  const items = opts.items ?? [{ name: 'Acme', url: 'https://acme.co' }];
  const startCalls: ApifySpy['startCalls'] = [];
  const aborted: string[] = [];
  let failuresLeft = opts.failStartWith?.times ?? (opts.failStartWith ? Infinity : 0);

  const run = {
    id: 'spy-run-1',
    status: opts.status ?? 'SUCCEEDED',
    defaultDatasetId: 'spy-dataset-1',
    usageTotalUsd: opts.usageUsd ?? 0.01,
  };

  return {
    startCalls,
    aborted,
    lastStart: () => startCalls[startCalls.length - 1],

    actor(actorId: string) {
      return {
        async start(input: unknown, options: unknown) {
          startCalls.push({ actorId, input, options });
          if (failuresLeft > 0) {
            failuresLeft--;
            const e = new Error('stub failure') as Error & { statusCode: number };
            e.statusCode = opts.failStartWith!.statusCode;
            throw e;
          }
          return run;
        },
      };
    },

    run(runId: string) {
      return {
        async get() { return run; },
        async abort() { aborted.push(runId); return run; },
      };
    },

    dataset() {
      return { async listItems() { return { items }; } };
    },
  };
}
