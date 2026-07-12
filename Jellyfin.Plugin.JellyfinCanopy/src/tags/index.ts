// src/tags/index.ts
// their required execution order (the former allComponentScripts order).
// Owned by the tags conversion wave; main.ts imports this barrel once, so
// conversions never edit main.ts itself.
import './genretags';
import './languagetags';
import './peopletags';
import './qualitytags';
import './ratingtags';
import './userreviewtags';
