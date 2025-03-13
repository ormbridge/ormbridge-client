#!/usr/bin/env node
import dotenv from 'dotenv';
dotenv.config();

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { generateSchema } from './commands/syncModels.js';

yargs(hideBin(process.argv))
  .command(
    'sync-models',
    'Generate model classes from the openapi schema',
    // No CLI options since API_URL and GENERATED_TYPES_DIR are read from .env.
    {},
    async () => {
      await generateSchema({});
    }
  )
  .help()
  .argv;