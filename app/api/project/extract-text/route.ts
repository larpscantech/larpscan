import { NextRequest } from 'next/server';
import { fetchWebsiteText } from '@/lib/scraper';
import { ok, err, withErrorHandler } from '@/lib/api-helpers';

export const POST = withErrorHandler(async (req: Request) => {
  const body = await (req as NextRequest).json().catch(() => ({}));
  const website = (body?.website ?? '').trim();

  if (!website) {
    return err('website is required');
  }

  const text = await fetchWebsiteText(website);

  if (!text || text.length < 50) {
    return err(
      'Could not extract meaningful content from the website. ' +
      'The site may require JavaScript or be behind a bot-protection wall.',
      422,
    );
  }

  return ok({ text, charCount: text.length });
});
