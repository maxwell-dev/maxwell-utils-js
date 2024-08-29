import { AbortablePromise, AbortError } from "@xuchaoqian/abortable-promise";
import { msg_types } from "maxwell-protocol";
import {
  Connection,
  makeConnectionOptions,
  TimeoutError,
  Event,
  MultiAltEndpointsConnection,
  ConnectionPool,
  makeConnectionPoolOptions,
} from "../src/index";

describe("Connection", () => {
  it("normal request", async () => {
    const conn = new Connection("localhost:10000", makeConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.req_req_t({
        path: "/hello",
        payload: JSON.stringify({}),
        header: {},
      });
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      const result = await request;
      expect(JSON.parse(result.payload)).toEqual("world");
    } catch (reason) {
      console.error(`Error occured: ${reason.stack}`);
    } finally {
      await conn.closeAndWait();
    }
  });

  it("path not exist", async () => {
    const conn = new Connection("localhost:10000", makeConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.req_req_t({
        path: "/path-not-exist",
        payload: JSON.stringify({}),
        header: {},
      });
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toEqual(
        `code: 299, desc: Failed to get connetion: err: Failed to find endpoint: path: "/path-not-exist"`,
      );
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to connect", async () => {
    const conn = new Connection("localhost:1", makeConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen(1000);
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toMatch("Timeout to wait: waiter:");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to request", async () => {
    const conn = new Connection("localhost:10000", makeConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`{"ref":1}`);
    } finally {
      await conn.closeAndWait();
    }
  });

  it("failed to encode", async () => {
    const conn = new Connection("localhost:10000", makeConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = {};
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(AbortError);
      expect(e.message).toEqual(
        "Error: Failed to encode msg: reason: undefined",
      );
    } finally {
      await conn.closeAndWait();
    }
  });

  it("on connected", async () => {
    const conn = new Connection("localhost:10000", makeConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      const result = await conn.waitEvent(Event.ON_CONNECTED, 1000);
      expect(result[0]).toBeInstanceOf(Connection);
    } finally {
      await conn.closeAndWait();
    }
  });
});

describe("MultiAltEndpointsConnection", () => {
  it("normal request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      makeConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      const req = new msg_types.req_req_t({
        path: "/hello",
        payload: JSON.stringify({}),
        header: {},
      });
      await conn.waitOpen();
      const request = conn.request(req, 1000);
      expect(request).toBeInstanceOf(AbortablePromise);
      const result = await request;
      expect(JSON.parse(result.payload)).toEqual("world");
    } catch (reason) {
      console.error(`Error occured: ${reason.stack}`);
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to connect", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:1"),
      makeConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen(1000);
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toMatch("Timeout to wait: waiter:");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      makeConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen(1000);
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, 2000);
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`{"ref":1}`);
    } finally {
      await conn.closeAndWait();
    }
  });

  it("on connected", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      makeConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      const result = await conn.waitEvent(Event.ON_CONNECTED);
      expect(result[0]).toBeInstanceOf(MultiAltEndpointsConnection);
    } finally {
      await conn.closeAndWait();
    }
  });
});

describe("ConnectionPool", () => {
  it("initial size", async () => {
    const options = makeConnectionPoolOptions();
    const pool = new ConnectionPool(
      () => AbortablePromise.resolve("localhost:10000"),
      options,
    );
    await pool.waitAllOpen();
    expect(pool.size()).toEqual(1);
    await pool.closeAndWait();
  });

  it(
    "unhealthy timeout",
    async () => {
      const options = makeConnectionPoolOptions({
        heartbeatInterval: 5000,
        unhealthyTimeout: 1000,
        roundLogEnabled: true,
      });
      const pool = new ConnectionPool(
        () => AbortablePromise.resolve("localhost:10000"),
        options,
      );
      try {
        expect(pool.size()).toEqual(1);
        await pool.waitAllOpen();
        const conn = pool.getConnection();
        expect(pool.size()).toEqual(1);
        expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
        const result = await conn.waitEvent(Event.ON_BECAME_UNHEALTHY);
        expect(result[0]).toBeInstanceOf(MultiAltEndpointsConnection);
        pool.getConnection();
        expect(pool.size()).toEqual(2);
      } finally {
        await pool.closeAndWait();
      }
    },
    10 * 1000,
  );

  it(
    "idle timeout",
    async () => {
      const options = makeConnectionPoolOptions({
        unhealthyTimeout: 5000,
        idleTimeout: 1000,
        roundLogEnabled: true,
      });
      const pool = new ConnectionPool(
        () => AbortablePromise.resolve("localhost:10000"),
        options,
      );
      try {
        expect(pool.size()).toEqual(1);
        await pool.waitAllOpen();
        const conn = pool.getConnection();
        expect(pool.size()).toEqual(1);
        expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
        const result = await conn.waitEvent(Event.ON_BECAME_IDLE);
        expect(result[0]).toBeInstanceOf(MultiAltEndpointsConnection);
        expect(pool.size()).toEqual(1);
      } finally {
        await pool.closeAndWait();
      }
    },
    10 * 1000,
  );
});
