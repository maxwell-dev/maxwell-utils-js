import {
  AbortError,
  TimeoutError,
  AbortController,
  AbortSignal,
  AbortablePromise,
} from "@xuchaoqian/abortable-promise";
import { msg_types } from "maxwell-protocol";
import {
  Event,
  Connection,
  ConnectionFactory,
  buildConnectionOptions,
  MultiAltEndpointsConnection,
  MultiAltEndpointsConnectionFactory,
  ConnectionPool,
  buildConnectionPoolOptions,
} from "../src/index";

describe("Connection", () => {
  it("normal request", async () => {
    const conn = new Connection("localhost:10000", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.req_req_t({
        path: "/hello",
        payload: JSON.stringify({}),
        header: {},
      });
      const request = conn.request(req, { timeout: 1000 });
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
    const conn = new Connection("localhost:10000", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.req_req_t({
        path: "/path-not-exist",
        payload: JSON.stringify({}),
        header: {},
      });
      const request = conn.request(req, { timeout: 1000 });
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toMatch(
        `code: 299, desc: Failed to get connetion: err: Failed to find endpoint: path: "/path-not-exist"`,
      );
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to connect", async () => {
    const conn = new Connection("localhost:1", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen({ timeout: 1000 });
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toMatch("Timeout to wait: waiter:");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to request", async () => {
    const conn = new Connection("localhost:10000", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, { timeout: 1000 });
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`{"ref":1}`);
    } finally {
      await conn.closeAndWait();
    }
  });

  it("abort request", async () => {
    const conn = new Connection("localhost:10000", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, {
        timeout: 5000,
      });
      expect(request).toBeInstanceOf(AbortablePromise);
      setTimeout(() => {
        request.abort();
      }, 1000);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(DOMException);
      expect(e.name).toEqual("AbortError");
      expect(e.message).toEqual("This operation was aborted");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("failed to encode", async () => {
    const conn = new Connection("localhost:10000", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      await conn.waitOpen();
      const req = {};
      const request = conn.request(req, { timeout: 1000 });
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
    const conn = new Connection("localhost:10000", buildConnectionOptions());
    expect(conn).toBeInstanceOf(Connection);
    try {
      const result = await conn.waitEvent(Event.ON_CONNECTED, {
        timeout: 1000,
      });
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
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      const req = new msg_types.req_req_t({
        path: "/hello",
        payload: JSON.stringify({}),
        header: {},
      });
      await conn.waitOpen();
      const request = conn.request(req, { timeout: 1000 });
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
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen({ timeout: 1000 });
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toMatch("Timeout to wait: waiter:");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("signal.timeout to connect", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:1"),
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen({ signal: AbortSignal.timeout(1000) });
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toMatch("The operation was aborted due to timeout");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("timeout to request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen({ timeout: 1000 });
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, { timeout: 2000 });
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual(`{"ref":1}`);
    } finally {
      await conn.closeAndWait();
    }
  });

  it("signal.timeout to request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen({ timeout: 1000 });
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, { signal: AbortSignal.timeout(1000) });
      expect(request).toBeInstanceOf(AbortablePromise);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError);
      expect(e.message).toEqual("The operation was aborted due to timeout");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("abort request", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen({ timeout: 1000 });
      const controller = new AbortController();
      const req = new msg_types.ping_req_t({});
      const request = conn.request(req, {
        timeout: 5000,
        signal: controller.signal,
      });
      expect(request).toBeInstanceOf(AbortablePromise);
      setTimeout(() => {
        controller.abort();
      }, 1000);
      await request;
    } catch (e) {
      expect(e).toBeInstanceOf(AbortError);
      expect(e.name).toEqual("AbortError");
      expect(e.message).toEqual("This operation was aborted");
    } finally {
      await conn.closeAndWait();
    }
  });

  it("abort multi requests", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      buildConnectionOptions(),
    );
    expect(conn).toBeInstanceOf(MultiAltEndpointsConnection);
    try {
      await conn.waitOpen({ timeout: 1000 });
      const controller = new AbortController();

      const req1 = new msg_types.ping_req_t({});
      const req2 = new msg_types.ping_req_t({});
      const request1 = conn.request(req1, {
        timeout: 5000,
        signal: controller.signal,
      });
      const request2 = conn.request(req2, {
        timeout: 5000,
        signal: controller.signal,
      });
      expect(request1).toBeInstanceOf(AbortablePromise);
      expect(request2).toBeInstanceOf(AbortablePromise);

      setTimeout(() => {
        controller.abort();
      }, 1000);

      try {
        await request1;
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect(e.name).toEqual("AbortError");
        expect(e.message).toEqual("This operation was aborted");
      }

      try {
        await request2;
      } catch (e) {
        expect(e).toBeInstanceOf(DOMException);
        expect(e.name).toEqual("AbortError");
        expect(e.message).toEqual("This operation was aborted");
      }
    } finally {
      await conn.closeAndWait();
    }
  });

  it("on connected", async () => {
    const conn = new MultiAltEndpointsConnection(
      () => AbortablePromise.resolve("localhost:10000"),
      buildConnectionOptions(),
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

describe("ConnectionPool<Connection>", () => {
  it("initial size", async () => {
    const options = buildConnectionPoolOptions();
    const pool = new ConnectionPool(
      new ConnectionFactory("localhost:10000"),
      options,
    );
    await pool.waitAllOpen();
    expect(pool.size()).toEqual(1);
    await pool.closeAndWait();
  });

  it(
    "unhealthy timeout",
    async () => {
      const options = buildConnectionPoolOptions({
        heartbeatInterval: 5000,
        unhealthyTimeout: 1000,
        roundLogEnabled: true,
      });
      const pool = new ConnectionPool(
        new ConnectionFactory("localhost:10000"),
        options,
      );
      try {
        expect(pool.size()).toEqual(1);
        await pool.waitAllOpen();
        const conn = pool.getConnection();
        expect(pool.size()).toEqual(1);
        expect(conn).toBeInstanceOf(Connection);
        const result = await conn.waitEvent(Event.ON_BECAME_UNHEALTHY);
        expect(result[0]).toBeInstanceOf(Connection);
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
      const options = buildConnectionPoolOptions({
        unhealthyTimeout: 5000,
        idleTimeout: 1000,
        roundLogEnabled: true,
      });
      const pool = new ConnectionPool(
        new ConnectionFactory("localhost:10000"),
        options,
      );
      try {
        expect(pool.size()).toEqual(1);
        await pool.waitAllOpen();
        const conn = pool.getConnection();
        expect(pool.size()).toEqual(1);
        expect(conn).toBeInstanceOf(Connection);
        const result = await conn.waitEvent(Event.ON_BECAME_IDLE);
        expect(result[0]).toBeInstanceOf(Connection);
        expect(pool.size()).toEqual(1);
      } finally {
        await pool.closeAndWait();
      }
    },
    10 * 1000,
  );
});

describe("ConnectionPool<MultiAltEndpointsConnection>", () => {
  it("initial size", async () => {
    const options = buildConnectionPoolOptions();
    const pool = new ConnectionPool(
      new MultiAltEndpointsConnectionFactory(() =>
        AbortablePromise.resolve("localhost:10000"),
      ),
      options,
    );
    await pool.waitAllOpen();
    expect(pool.size()).toEqual(1);
    await pool.closeAndWait();
  });

  it(
    "unhealthy timeout",
    async () => {
      const options = buildConnectionPoolOptions({
        heartbeatInterval: 5000,
        unhealthyTimeout: 1000,
        roundLogEnabled: true,
      });
      const pool = new ConnectionPool(
        new MultiAltEndpointsConnectionFactory(() =>
          AbortablePromise.resolve("localhost:10000"),
        ),
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
      const options = buildConnectionPoolOptions({
        unhealthyTimeout: 5000,
        idleTimeout: 1000,
        roundLogEnabled: true,
      });
      const pool = new ConnectionPool(
        new MultiAltEndpointsConnectionFactory(() =>
          AbortablePromise.resolve("localhost:10000"),
        ),
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
