import { bootstrapEnvironment } from '../src/platform/bootstrap/environment.ts';
import { composeHttpHandler } from '../src/platform/bootstrap/composition.ts';
import { createVercelHandler } from '../src/platform/vercel/vercel-handler.ts';

export default createVercelHandler(() => composeHttpHandler(bootstrapEnvironment()));
