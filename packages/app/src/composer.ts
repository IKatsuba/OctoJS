import type {
  WebhookEventMap,
  WebhookEventName,
} from '@octokit/webhooks-types';
import type { Context } from './context.ts';

export type EventAction<T extends WebhookEventName> = 'action' extends
  keyof WebhookEventMap[T] ? WebhookEventMap[T]['action'] : never;

type Query<K extends string = string> = K extends `${infer Q}.${infer R}`
  ? Q extends WebhookEventName ? R extends EventAction<Q> ? `${Q}.${R}`
    : never
  : never
  : K extends WebhookEventName ? K
  : never;

export type MaybeArray<T> = T | T[];

type MaybePromise<T> = T | Promise<T>;

export type NextFunction = () => Promise<void>;

export type MiddlewareFn<C extends Context = Context> = (
  ctx: C,
  next: NextFunction,
) => MaybePromise<unknown>;

export interface MiddlewareObj<C extends Context = Context> {
  middleware: () => MiddlewareFn<C>;
}

export type Middleware<C extends Context = Context> =
  | MiddlewareFn<C>
  | MiddlewareObj<C>;

export class BotError<C extends Context = Context> extends Error {
  constructor(public readonly error: unknown, public readonly ctx: C) {
    super(generateBotErrorMessage(error));
    this.name = 'BotError';
    if (error instanceof Error) this.stack = error.stack;
  }
}
function generateBotErrorMessage(error: unknown) {
  let msg: string;
  if (error instanceof Error) {
    msg = `${error.name} in middleware: ${error.message}`;
  } else {
    const type = typeof error;
    msg = `Non-error value of type ${type} thrown in middleware`;
    switch (type) {
      case 'bigint':
      case 'boolean':
      case 'number':
      case 'symbol':
        msg += `: ${error}`;
        break;
      case 'string':
        msg += `: ${String(error).substring(0, 50)}`;
        break;
      default:
        msg += '!';
        break;
    }
  }
  return msg;
}

function flatten<C extends Context>(mw: Middleware<C>): MiddlewareFn<C> {
  return typeof mw === 'function'
    ? mw
    : (ctx, next) => mw.middleware()(ctx, next);
}
function concat<C extends Context>(
  first: MiddlewareFn<C>,
  andThen: MiddlewareFn<C>,
): MiddlewareFn<C> {
  return async (ctx, next) => {
    let nextCalled = false;
    await first(ctx, async () => {
      if (nextCalled) throw new Error('`next` already called before!');
      else nextCalled = true;
      await andThen(ctx, next);
    });
  };
}
function pass<C extends Context>(_ctx: C, next: NextFunction) {
  return next();
}

const leaf: NextFunction = () => Promise.resolve();
/**
 * Runs some given middleware function with a given context object.
 *
 * @param middleware The middleware to run
 * @param ctx The context to use
 */
export async function run<C extends Context>(
  middleware: MiddlewareFn<C>,
  ctx: C,
) {
  await middleware(ctx, leaf);
}

export class Composer<C extends Context> implements MiddlewareObj<C> {
  private handler: MiddlewareFn<C>;

  constructor(...middleware: Array<Middleware<C>>) {
    this.handler = middleware.length === 0
      ? pass
      : middleware.map(flatten).reduce(concat);
  }

  middleware() {
    return this.handler;
  }

  use(...middleware: Array<Middleware<C>>) {
    const composer = new Composer(...middleware);
    this.handler = concat(this.handler, flatten(composer));
    return composer;
  }

  on<K extends string>(
    filter: MaybeArray<Query<K>>,
    ...middleware: Array<Middleware<C>>
  ): Composer<C> {
    return this.filter((c) => {
      const query = Array.isArray(filter) ? filter : [filter];
      return query.some((q) => {
        const [event, action] = q.split('.') as [
          WebhookEventName,
          EventAction<WebhookEventName>,
        ];

        if (event !== c.eventName) {
          return false;
        }

        if (action === undefined) {
          return true;
        }

        return 'action' in c.event && action === c.event.action;
      });
    }, ...middleware);
  }

  filter<D extends C>(
    predicate: (ctx: C) => ctx is D,
    ...middleware: Array<Middleware<D>>
  ): Composer<D>;
  filter(
    predicate: (ctx: C) => MaybePromise<boolean>,
    ...middleware: Array<Middleware<C>>
  ): Composer<C>;
  filter(
    predicate: (ctx: C) => MaybePromise<boolean>,
    ...middleware: Array<Middleware<C>>
  ) {
    const composer = new Composer(...middleware);
    this.branch(predicate, composer, pass);
    return composer;
  }

  drop(
    predicate: (ctx: C) => MaybePromise<boolean>,
    ...middleware: Array<Middleware<C>>
  ) {
    return this.filter(
      async (ctx: C) => !(await predicate(ctx)),
      ...middleware,
    );
  }

  lazy(
    middlewareFactory: (ctx: C) => MaybePromise<MaybeArray<Middleware<C>>>,
  ): Composer<C> {
    return this.use(async (ctx, next) => {
      const middleware = await middlewareFactory(ctx);
      const arr = Array.isArray(middleware) ? middleware : [middleware];
      await flatten(new Composer(...arr))(ctx, next);
    });
  }
  route<R extends Record<PropertyKey, Middleware<C>>>(
    router: (ctx: C) => MaybePromise<undefined | keyof R>,
    routeHandlers: R,
    fallback: Middleware<C> = pass,
  ): Composer<C> {
    return this.lazy(async (ctx) => {
      const route = await router(ctx);
      return (route === undefined || !routeHandlers[route]
        ? fallback
        : routeHandlers[route]) ?? [];
    });
  }

  branch(
    predicate: (ctx: C) => MaybePromise<boolean>,
    trueMiddleware: MaybeArray<Middleware<C>>,
    falseMiddleware: MaybeArray<Middleware<C>>,
  ) {
    return this.lazy(async (ctx) =>
      (await predicate(ctx)) ? trueMiddleware : falseMiddleware
    );
  }

  errorBoundary(
    errorHandler: (
      error: BotError<C>,
      next: NextFunction,
    ) => MaybePromise<unknown>,
    ...middleware: Array<Middleware<C>>
  ) {
    const composer = new Composer<C>(...middleware);
    const bound = flatten(composer);
    this.use(async (ctx, next) => {
      let nextCalled = false;
      const cont = () => ((nextCalled = true), Promise.resolve());
      try {
        await bound(ctx, cont);
      } catch (err) {
        nextCalled = false;
        await errorHandler(new BotError<C>(err, ctx), cont);
      }
      if (nextCalled) await next();
    });
    return composer;
  }

  handle(ctx: C) {
    return run(this.middleware(), ctx);
  }
}
