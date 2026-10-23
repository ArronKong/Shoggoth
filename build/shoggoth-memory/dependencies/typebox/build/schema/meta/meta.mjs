import { Draft_2020_12 } from './draft_2020_12.mjs';
import { Draft_2019_09 } from './draft_2019_09.mjs';
import { Draft_7 } from './draft_7.mjs';
import { Draft_6 } from './draft_6.mjs';
import { Draft_4 } from './draft_4.mjs';
import { Draft_3 } from './draft_3.mjs';
/** A collection of all meta schemas. */
export const Meta = {
    'http://json-schema.org/draft-03/schema#': Draft_3,
    'http://json-schema.org/draft-04/schema#': Draft_4,
    'http://json-schema.org/draft-06/schema#': Draft_6,
    'http://json-schema.org/draft-07/schema#': Draft_7,
    'https://json-schema.org/draft/2019-09/schema': Draft_2019_09,
    'https://json-schema.org/draft/2020-12/schema': Draft_2020_12
};
