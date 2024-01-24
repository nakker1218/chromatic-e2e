import { outputFile, ensureDir, outputJson } from 'fs-extra';
import { join } from 'path';
import { logger } from '../utils/logger';
import { ArchiveFile } from './archive-file';
import { DOMSnapshot } from './dom-snapshot';
import type { ResourceArchive } from '../resource-archive';
import type { ChromaticStorybookParameters } from '../types';
import { Viewport, viewportToString } from '../utils/viewport';

// @storybook/csf's sanitize function, we could import this
export const sanitize = (string: string) => {
  return (
    string
      .toLowerCase()
      // eslint-disable-next-line no-useless-escape
      .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, '-')
      .replace(/-+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
  );
};

// We write a collection of DOM snapshots and a resource archive in the following locations:
// <test-title>.stories.json
// archive/<test-title>.json
// archive/<file>.<ext>

interface E2ETestInfo {
  titlePath: string[];
  outputDir: string;
  pageUrl: string;
  viewport: Viewport;
}

function snapshotFileName(title: string, name: string, viewport: Viewport) {
  const fileNameParts = [
    `${sanitize(title)}-${sanitize(name)}`,
    viewportToString(viewport),
    'snapshot',
    'json',
  ];
  return fileNameParts.join('.');
}

export async function writeTestResult(
  e2eTestInfo: E2ETestInfo,
  domSnapshots: Record<string, Buffer>,
  archive: ResourceArchive,
  chromaticStorybookParams: ChromaticStorybookParameters
) {
  const { titlePath, outputDir, pageUrl, viewport } = e2eTestInfo;
  // remove the test file extensions (.spec.ts|ts, .cy.ts|js), preserving other periods in directory, file name, or test titles
  const titlePathWithoutFileExtensions = titlePath.map((pathPart) =>
    // make sure we remove file extensions, even if the file name doesn't have .spec or .test or.cy
    // possible extensions:
    // playwright: https://playwright.dev/docs/test-configuration#filtering-tests
    // cypress: https://docs.cypress.io/guides/core-concepts/writing-and-organizing-tests#Spec-files
    pathPart.replace(/\.(ts|js|mjs|cjs|tsx|jsx|cjsx|coffee)$/, '').replace(/\.(spec|test|cy)$/, '')
  );
  // in Storybook, `/` splits the title out into hierarchies (folders)
  const title = titlePathWithoutFileExtensions.join('/');
  // outputDir gives us the test-specific subfolder (https://playwright.dev/docs/api/class-testconfig#test-config-output-dir);
  // we want to write one level above that
  const finalOutputDir = join(outputDir, '..', 'chromatic-archives');

  const archiveDir = join(finalOutputDir, 'archive');

  await ensureDir(finalOutputDir);

  logger.log(`Writing test results for "${title}"`);

  // Used to store any changes to the asset paths made in order to save them to the file system
  // so that we can update the `src` attributes in the DOM snapshots.
  const sourceMap = new Map<string, string>();

  await Promise.all(
    Object.entries(archive).map(async ([url, response]) => {
      if ('error' in response) return;

      const archiveFile = new ArchiveFile(url, response, pageUrl);
      const origSrcPath = archiveFile.originalSrc();
      const fileSystemPath = archiveFile.toFileSystemPath();

      if (origSrcPath !== fileSystemPath) {
        sourceMap.set(origSrcPath, fileSystemPath);
      }

      await outputFile(join(archiveDir, fileSystemPath), response.body);
    })
  );

  await Promise.all(
    await Object.entries(domSnapshots).map(async ([name, domSnapshot]) => {
      // XXX_jwir3: We go through our stories here and map any instances that are found in
      //            the keys of the source map to their respective values.
      const snapshot = new DOMSnapshot(domSnapshot);
      const mappedSnapshot = await snapshot.mapAssetPaths(sourceMap);

      await outputFile(join(archiveDir, snapshotFileName(title, name, viewport)), mappedSnapshot);
    })
  );

  const storiesFileNameParts = [`${sanitize(title)}`, 'stories', 'json'];
  await writeStoriesFile(
    join(finalOutputDir, storiesFileNameParts.join('.')),
    title,
    viewport,
    domSnapshots,
    chromaticStorybookParams
  );

  const errors = Object.entries(archive).filter(([, r]) => 'error' in r);
  if (errors.length > 0) {
    logger.log(`Encountered ${errors.length} errors archiving resources, writing to 'errors.json'`);
    await outputJson(join(archiveDir, `errors.json`), {
      errors: Object.fromEntries(errors),
    });
  }
}

async function writeStoriesFile(
  storiesFilename: string,
  title: string,
  viewport: Viewport,
  domSnapshots: Record<string, Buffer>,
  chromaticStorybookParams: ChromaticStorybookParameters
) {
  logger.log(`Writing ${storiesFilename}`);
  await outputJson(storiesFilename, {
    title,
    stories: Object.keys(domSnapshots).map((name) => ({
      name,
      parameters: {
        server: { id: snapshotFileName(title, name, viewport) },
        chromatic: {
          ...chromaticStorybookParams,
        },
      },
    })),
  });
}
