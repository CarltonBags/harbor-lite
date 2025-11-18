/**
 * WebContainer utilities for StudyFucker
 * Handles initialization and management of Stackblitz WebContainer instances for LaTeX compilation
 */

let webcontainerInstance: any = null;

/**
 * Initialize and boot a WebContainer instance
 */
export async function initWebContainer(): Promise<any> {
  // Only import WebContainer on the client side
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('WebContainer can only be initialized in the browser');
  }

  if (webcontainerInstance) {
    return webcontainerInstance;
  }

  try {
    // Dynamic import to avoid SSR issues
    let webcontainerModule: any;
    let WebContainer: any;
    
    try {
      // Try standard dynamic import
      webcontainerModule = await import('@webcontainer/api');
      WebContainer = webcontainerModule.WebContainer;
    } catch (importError: any) {
      console.error('First import attempt failed:', importError);
      
      // Try with explicit chunk name (helps with some bundlers)
      try {
        webcontainerModule = await import(
          /* webpackChunkName: "webcontainer" */ 
          '@webcontainer/api'
        );
        WebContainer = webcontainerModule.WebContainer;
      } catch (secondError: any) {
        console.error('Second import attempt failed:', secondError);
        throw importError; // Throw original error
      }
    }
    
    if (!WebContainer) {
      console.error('Module structure:', Object.keys(webcontainerModule || {}));
      throw new Error('WebContainer export not found in @webcontainer/api module');
    }
    
    if (typeof WebContainer.boot !== 'function') {
      console.error('WebContainer type:', typeof WebContainer);
      console.error('WebContainer keys:', Object.keys(WebContainer || {}));
      throw new Error('WebContainer.boot is not a function. WebContainer may not be properly loaded.');
    }
    
    webcontainerInstance = await WebContainer.boot();
    return webcontainerInstance;
  } catch (error: any) {
    console.error('Failed to load WebContainer:', error);
    console.error('Error details:', {
      message: error?.message,
      stack: error?.stack,
      name: error?.name,
      code: error?.code,
    });
    
    // Provide more helpful error message
    if (error?.message?.includes('Cannot find module') || error?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `@webcontainer/api module not found. This might be a Turbopack bundling issue. Try: 1) Refreshing the page, 2) Running without --turbo flag, or 3) Check browser console for detailed error. Original: ${error.message}`
      );
    }
    
    throw new Error(
      `WebContainer API is not available: ${error?.message || 'Unknown error'}. Make sure you are running in a browser environment and @webcontainer/api is installed.`
    );
  }
}

/**
 * Get the current WebContainer instance
 */
export function getWebContainer(): any {
  return webcontainerInstance;
}

/**
 * Reset the WebContainer instance (useful for cleanup)
 */
export function resetWebContainer(): void {
  webcontainerInstance = null;
}

