import { createVercelHandler } from '../src/platform/vercel/vercel-handler.ts';

export default createVercelHandler(async () => {
  const [{ bootstrapEnvironment }, { composeHttpHandler }] = await Promise.all([
    import('../src/platform/bootstrap/environment.ts'),
    import('../src/platform/bootstrap/composition.ts'),
  ]);
  return composeHttpHandler(bootstrapEnvironment());
});
