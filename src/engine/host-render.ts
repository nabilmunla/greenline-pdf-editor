// Drawing engine process (PDFium).
import { startHost, renderHandlers, renderRecycle } from './host';
startHost('render', renderHandlers(), undefined, renderRecycle);
