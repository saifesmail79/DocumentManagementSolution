/**
 * The organisation's name, wherever the system names itself.
 *
 * `organisation.name` was a stored setting that nothing displayed — editable,
 * persisted, and invisible, so the screen said the generic name whatever the
 * administrator typed. Every place that shows the system's name now takes it
 * from here, and the setting is real.
 *
 * The default is painted first and replaced when the fetch lands. The reverse —
 * blank until fetched — would hold the sign-in screen hostage to a settings
 * lookup, which is the wrong dependency in both directions.
 */

import { useEffect, useState } from 'react';

import { api } from './api.js';

export const DEFAULT_NAME = 'نظام إدارة الوثائق';

export function useBranding() {
  const [name, setName] = useState(DEFAULT_NAME);

  useEffect(() => {
    let cancelled = false;

    api
      .branding()
      .then((result) => {
        if (!cancelled && result?.organisationName) setName(result.organisationName);
      })
      .catch(() => {
        /* the default already stands */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.title = name;
  }, [name]);

  return name;
}
