import { LinkedInConnector } from './linkedin';
import { XConnector } from './x';
import { NewsletterConnector } from './newsletter';
import type { Channel, Connector } from './types';

export * from './types';

const REGISTRY: Record<Channel, Connector> = {
  linkedin: new LinkedInConnector(),
  x: new XConnector(),
  newsletter: new NewsletterConnector(),
};

export const connectorFor = (c: Channel): Connector => REGISTRY[c];

/** Rendered on the queue page so an operator can see which lanes are live. */
export const connectorAvailability = () =>
  Object.fromEntries(
    (Object.keys(REGISTRY) as Channel[]).map((c) => [c, REGISTRY[c].available()]),
  ) as Record<Channel, boolean>;
