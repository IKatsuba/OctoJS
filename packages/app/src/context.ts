import type {
  WebhookEventMap,
  WebhookEventName,
} from '@octokit/webhooks-types';

export class Context<T extends WebhookEventName = WebhookEventName> {
  constructor(
    public readonly eventName: T,
    public readonly event: WebhookEventMap[T],
  ) {}
}
