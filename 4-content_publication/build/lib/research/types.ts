export type FetchStatus =
  | 'ok' | 'paywalled' | 'robots_denied' | 'boilerplate' | 'too_large' | 'failed';

export type SectionProfile = { heading: string; level: number; words: number }[];

export type FetchedSource = {
  submittedUrl: string;
  finalUrl?: string;
  // `upload` is a file somebody attached, read by the model. It sits in the
  // same table and goes through the same screen as a scraped page, because as
  // far as excerpts, citations and grounding are concerned it is a source that
  // arrived by a different route.
  provider: 'firecrawl' | 'web_fetch' | 'manual' | 'upload';
  httpStatus?: number;
  status: FetchStatus;
  failureReason?: string;
  markdown?: string;
  contentHash: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  sectionProfile: SectionProfile;
};
