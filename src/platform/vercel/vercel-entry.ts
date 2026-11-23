import { bootstrapEnvironment } from '../bootstrap/environment.ts';
import { composeHttpHandler } from '../bootstrap/composition.ts';
import { createVercelHandler } from './vercel-handler.ts';
import { createWebHandler } from './web-handler.ts';

const handler = createVercelHandler(() => composeHttpHandler(bootstrapEnvironment()));

export default { fetch: createWebHandler(handler) };
