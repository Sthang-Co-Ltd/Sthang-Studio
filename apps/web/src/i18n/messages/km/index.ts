import type { KhmerCatalog } from '../../types';
import { common } from './common';
import { editor } from './editor';
import { home } from './home';
import { review } from './review';
import { setup } from './setup';

export const km: KhmerCatalog = { common, home, setup, editor, review };
