/**
 * Разбор тела HTTP-запроса без внешних зависимостей.
 *
 * Клиент присылает исходное видео и трек ОДНИМ multipart/form-data запросом.
 * Парсер сначала дочитывает запрос целиком и только потом разбирает его на
 * поля и файлы — поэтому порядок частей не имеет значения: текстовое поле
 * `track`, идущее ПОСЛЕ файла, не теряется.
 *
 * Дополнительно поддержаны application/json (видео как data-url/base64),
 * x-www-form-urlencoded и «голая» загрузка бинарника (Content-Type: video/*).
 */
import type { IncomingMessage } from 'node:http';

export interface MultipartFile {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface ParsedBody {
  fields: Record<string, string>;
  files: MultipartFile[];
  json?: unknown;
  raw?: Buffer;
}

/** Предел разумного для загрузки ролика через браузер. */
export const DEFAULT_MAX_BODY_BYTES = 512 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super('request body exceeds ' + limit + ' bytes');
    this.name = 'PayloadTooLargeError';
    this.limit = limit;
  }
}

/** Дочитывает тело запроса целиком, обрывая слишком большие загрузки. */
export function readBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;

    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
      size += buf.length;
      if (size > maxBytes) {
        fail(new PayloadTooLargeError(maxBytes));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error: Error) => fail(error));
    req.on('aborted', () => fail(new Error('request aborted')));
  });
}

/**
 * Достаёт значение параметра заголовка: `name="video"`, `boundary=----xyz`.
 * Ключ ищется по границе токена, чтобы `name` не находился внутри `filename`.
 */
function headerParam(source: string, key: string): string | undefined {
  const quoted = new RegExp('(?:^|;|\\s)' + key + '\\s*=\\s*"([^"]*)"', 'i').exec(source);
  if (quoted) return quoted[1];
  const bare = new RegExp('(?:^|;|\\s)' + key + '\\s*=\\s*([^;]+)', 'i').exec(source);
  if (bare) return bare[1].trim();
  return undefined;
}

/** Граница multipart-тела из заголовка Content-Type (или null). */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  if (!/multipart\/form-data/i.test(contentType)) return null;
  const boundary = headerParam(contentType, 'boundary');
  return boundary && boundary.length > 0 ? boundary : null;
}

const CR = 13;
const LF = 10;
const DASH = 45;
const HEADER_SEP = Buffer.from([CR, LF, CR, LF]);

interface PartHeaders {
  name: string;
  filename?: string;
  contentType?: string;
}

function parsePartHeaders(raw: string): PartHeaders {
  let name = '';
  let filename: string | undefined;
  let contentType: string | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === 'content-disposition') {
      name = headerParam(value, 'name') ?? '';
      filename = headerParam(value, 'filename');
    } else if (key === 'content-type') {
      contentType = value;
    }
  }

  return { name, filename, contentType };
}

function looksBinary(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith('video/') || ct.startsWith('application/octet-stream');
}

/** Разбирает уже прочитанное multipart-тело на поля и файлы. */
export function parseMultipart(body: Buffer, boundary: string): ParsedBody {
  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];
  const delimiter = Buffer.from('--' + boundary, 'utf8');

  let position = body.indexOf(delimiter);
  if (position < 0) return { fields, files, raw: body };
  position += delimiter.length;

  while (position <= body.length) {
    // Завершающая граница: `--boundary--`.
    if (body[position] === DASH && body[position + 1] === DASH) break;

    while (position < body.length && (body[position] === CR || body[position] === LF)) {
      position += 1;
    }

    const headerEnd = body.indexOf(HEADER_SEP, position);
    if (headerEnd < 0) break;

    const headers = parsePartHeaders(body.subarray(position, headerEnd).toString('utf8'));
    const dataStart = headerEnd + HEADER_SEP.length;

    let next = body.indexOf(delimiter, dataStart);
    if (next < 0) next = body.length;

    let dataEnd = next;
    if (dataEnd - 2 >= dataStart && body[dataEnd - 2] === CR && body[dataEnd - 1] === LF) {
      dataEnd -= 2;
    } else if (dataEnd - 1 >= dataStart && body[dataEnd - 1] === LF) {
      dataEnd -= 1;
    }

    const data = body.subarray(dataStart, dataEnd);

    if (headers.name !== '' || headers.filename !== undefined) {
      if (headers.filename !== undefined || looksBinary(headers.contentType)) {
        files.push({
          name: headers.name,
          filename: headers.filename,
          contentType: headers.contentType,
          data: Buffer.from(data),
        });
      } else {
        fields[headers.name] = data.toString('utf8');
      }
    }

    position = next + delimiter.length;
  }

  return { fields, files, raw: body };
}

/** Читает и разбирает тело запроса в единый вид {fields, files, json}. */
export async function parseRequestBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<ParsedBody> {
  const contentType = req.headers['content-type'] ?? '';
  const body = await readBody(req, maxBytes);

  const boundary = multipartBoundary(contentType);
  if (boundary) return parseMultipart(body, boundary);

  if (/application\/json/i.test(contentType)) {
    let json: unknown = null;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = null;
    }
    const fields: Record<string, string> = {};
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
        fields[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    return { fields, files: [], json, raw: body };
  }

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const fields: Record<string, string> = {};
    const params = new URLSearchParams(body.toString('utf8'));
    params.forEach((value, key) => {
      fields[key] = value;
    });
    return { fields, files: [], raw: body };
  }

  if (body.length > 0 && looksBinary(contentType)) {
    return {
      fields: {},
      files: [{ name: 'video', filename: 'input.mp4', contentType, data: body }],
      raw: body,
    };
  }

  return { fields: {}, files: [], raw: body };
}
