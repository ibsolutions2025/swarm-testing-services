export class TargetUrlError extends Error {
  code: string;
}

export function isPublicIpAddress(address: string): boolean;
export function parseTargetUrl(input: string): URL;
export function assertPublicTargetUrl(
  input: string,
  options?: {
    lookup?: (
      hostname: string,
      options: { all: true; verbatim: true }
    ) => Promise<Array<{ address: string; family?: number }>>;
  }
): Promise<{ url: URL; addresses: string[] }>;
