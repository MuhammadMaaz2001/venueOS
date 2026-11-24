import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE } from './config';

// English only. There is no /[locale] URL segment and no language cookie: when a second language is added, the
// locale is read here (from the user's saved preference, falling back to the workspace's `defaultLocale`) and
// its messages file is loaded by name, exactly as below.
export default getRequestConfig(async () => {
  const locale = DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
