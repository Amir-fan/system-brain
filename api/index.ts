import { createVercelHandler } from '../src/platform/vercel/vercel-handler.ts';
import { createWebHandler } from '../src/platform/vercel/web-handler.ts';

const handler = createVercelHandler(async () => {
  const [{ bootstrapEnvironment }, { composeHttpHandler }] = await Promise.all([
    import('../src/platform/bootstrap/environment.ts'),
    import('../src/platform/bootstrap/composition.ts'),
  ]);
  return composeHttpHandler(bootstrapEnvironment());
});

export default { fetch: createWebHandler(handler) };
