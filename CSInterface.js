/*************************************************************************
 * CSInterface.js
 * Adobe CEP Interface
 *************************************************************************/

function CSInterface() {}

CSInterface.prototype.evalScript = function(script, callback) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        window.__adobe_cep__.evalScript(script, callback || function(){});
    } else {
        if (callback) callback("CEP_NOT_AVAILABLE");
    }
};

CSInterface.prototype.getSystemPath = function(pathType) {
    if (typeof window.__adobe_cep__ !== "undefined") {
        return window.__adobe_cep__.getSystemPath(pathType);
    }
    return "";
};

var SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication",
    DESKTOP: "desktop"
};
