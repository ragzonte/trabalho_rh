package com.wifiraiox.app;

import org.json.JSONObject;

/** Quem entrega eventos ('scan', 'rssi', 'status'...) para a página. */
interface Emitter {
    void emit(String event, JSONObject data);
}
