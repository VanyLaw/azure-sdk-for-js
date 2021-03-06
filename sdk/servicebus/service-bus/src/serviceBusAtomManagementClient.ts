// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  Constants as AMQPConstants,
  isTokenCredential,
  parseConnectionString,
  TokenCredential
} from "@azure/core-amqp";
import {
  bearerTokenAuthenticationPolicy,
  HttpOperationResponse,
  OperationOptions,
  proxyPolicy,
  ProxySettings,
  RequestPolicyFactory,
  RestError,
  ServiceClient,
  ServiceClientOptions,
  signingPolicy,
  stripRequest,
  stripResponse,
  URLBuilder,
  WebResource
} from "@azure/core-http";
import { PagedAsyncIterableIterator, PageSettings } from "@azure/core-paging";
import * as log from "./log";
import {
  buildNamespace,
  NamespaceProperties,
  NamespaceResourceSerializer
} from "./serializers/namespaceResourceSerializer";
import {
  buildQueue,
  buildQueueOptions,
  buildQueueRuntimeProperties,
  InternalQueueOptions,
  QueueDescription,
  QueueResourceSerializer,
  QueueRuntimeProperties
} from "./serializers/queueResourceSerializer";
import {
  buildRule,
  RuleDescription,
  RuleResourceSerializer
} from "./serializers/ruleResourceSerializer";
import {
  buildSubscription,
  buildSubscriptionOptions,
  buildSubscriptionRuntimeProperties,
  InternalSubscriptionOptions,
  SubscriptionDescription,
  SubscriptionResourceSerializer,
  SubscriptionRuntimeProperties
} from "./serializers/subscriptionResourceSerializer";
import {
  buildTopic,
  buildTopicOptions,
  buildTopicRuntimeProperties,
  InternalTopicOptions,
  TopicDescription,
  TopicResourceSerializer,
  TopicRuntimeProperties
} from "./serializers/topicResourceSerializer";
import { AtomXmlSerializer, executeAtomXmlOperation } from "./util/atomXmlHelper";
import * as Constants from "./util/constants";
import { SasServiceClientCredentials } from "./util/sasServiceClientCredentials";
import { isAbsoluteUrl, isJSONLikeObject } from "./util/utils";
import { parseURL } from "./util/parseUrl";

/**
 * Options to use with ServiceBusManagementClient creation
 */
export interface ServiceBusManagementClientOptions {
  /**
   * Proxy related settings
   */
  proxySettings?: ProxySettings;
}

/**
 * Request options for list<entity-type>() operations
 */
export interface ListRequestOptions {
  /**
   * Count of entities to fetch.
   */
  maxCount?: number;

  /**
   * Count of entities to skip from being fetched.
   */
  skip?: number;
}

/**
 * The underlying HTTP response.
 */
export interface Response {
  /**
   * The underlying HTTP response.
   */
  _response: HttpOperationResponse;
}

/**
 * Represents the result of list operation on entities which also contains the `continuationToken` to start iterating over from.
 */
export interface EntitiesResponse<T>
  extends Array<T>,
    Pick<PageSettings, "continuationToken">,
    Response {}

/**
 * Represents properties of the namespace.
 */
export interface NamespacePropertiesResponse extends NamespaceProperties, Response {}

/**
 * Represents runtime info of a queue.
 */
export interface QueueRuntimePropertiesResponse extends QueueRuntimeProperties, Response {}

/**
 * Represents result of create, get, and update operations on queue.
 */
export interface QueueResponse extends QueueDescription, Response {}

/**
 * Represents result of create, get, and update operations on topic.
 */
export interface TopicResponse extends TopicDescription, Response {}

/**
 * Represents runtime info of a topic.
 */
export interface TopicRuntimePropertiesResponse extends TopicRuntimeProperties, Response {}

/**
 * Represents result of create, get, and update operations on subscription.
 */
export interface SubscriptionResponse extends SubscriptionDescription, Response {}

/**
 * Represents runtime info of a subscription.
 */
export interface SubscriptionRuntimePropertiesResponse extends SubscriptionRuntimeProperties, Response {}

/**
 * Represents result of create, get, and update operations on rule.
 */
export interface RuleResponse extends RuleDescription, Response {}

/**
 * All operations return promises that resolve to an object that has the relevant output.
 * These objects also have a property called `_response` that you can use if you want to
 * access the direct response from the service.
 */
export class ServiceBusManagementClient extends ServiceClient {
  /**
   * Reference to the endpoint as extracted from input connection string.
   */
  private endpoint: string;

  /**
   * Reference to the endpoint with protocol prefix as extracted from input connection string.
   */
  private endpointWithProtocol: string;

  /**
   * Singleton instances of serializers used across the various operations.
   */
  private namespaceResourceSerializer: AtomXmlSerializer;
  private queueResourceSerializer: AtomXmlSerializer;
  private topicResourceSerializer: AtomXmlSerializer;
  private subscriptionResourceSerializer: AtomXmlSerializer;
  private ruleResourceSerializer: AtomXmlSerializer;

  /**
   * Credentials used to generate tokens as required for the various operations.
   */
  private credentials: SasServiceClientCredentials | TokenCredential;

  /**
   * Initializes a new instance of the ServiceBusManagementClient class.
   * @param connectionString The connection string needed for the client to connect to Azure.
   * @param options ServiceBusManagementClientOptions
   */
  constructor(connectionString: string, options?: ServiceBusManagementClientOptions);
  /**
   *
   * @param fullyQualifiedNamespace The fully qualified namespace of your Service Bus instance which is
   * likely to be similar to <yournamespace>.servicebus.windows.net.
   * @param credential A credential object used by the client to get the token to authenticate the connection
   * with the Azure Service Bus. See &commat;azure/identity for creating the credentials.
   * If you're using your own implementation of the `TokenCredential` interface against AAD, then set the "scopes" for service-bus
   * to be `["https://servicebus.azure.net//user_impersonation"]` to get the appropriate token.
   * @param options ServiceBusManagementClientOptions
   */
  constructor(
    fullyQualifiedNamespace: string,
    credential: TokenCredential,
    options?: ServiceBusManagementClientOptions
  );

  constructor(
    fullyQualifiedNamespaceOrConnectionString1: string,
    credentialOrOptions2?: TokenCredential | ServiceBusManagementClientOptions,
    options3?: ServiceBusManagementClientOptions
  ) {
    const requestPolicyFactories: RequestPolicyFactory[] = [];
    let options: ServiceBusManagementClientOptions;
    let fullyQualifiedNamespace: string;
    let credentials: SasServiceClientCredentials | TokenCredential;
    if (isTokenCredential(credentialOrOptions2)) {
      fullyQualifiedNamespace = fullyQualifiedNamespaceOrConnectionString1;
      options = options3 || {};
      credentials = credentialOrOptions2;
      requestPolicyFactories.push(
        bearerTokenAuthenticationPolicy(credentials, AMQPConstants.aadServiceBusScope)
      );
    } else {
      const connectionString = fullyQualifiedNamespaceOrConnectionString1;
      options = credentialOrOptions2 || {};
      const connectionStringObj: any = parseConnectionString(connectionString);
      if (connectionStringObj.Endpoint == undefined) {
        throw new Error("Missing Endpoint in connection string.");
      }
      try {
        fullyQualifiedNamespace = connectionStringObj.Endpoint.match(".*://([^/]*)")[1];
      } catch (error) {
        throw new Error("Endpoint in the connection string is not valid.");
      }
      credentials = new SasServiceClientCredentials(
        connectionStringObj.SharedAccessKeyName,
        connectionStringObj.SharedAccessKey
      );
      requestPolicyFactories.push(signingPolicy(credentials));
    }
    if (options && options.proxySettings) {
      requestPolicyFactories.push(proxyPolicy(options.proxySettings));
    }
    const serviceClientOptions: ServiceClientOptions = {
      requestPolicyFactories: requestPolicyFactories
    };

    super(credentials, serviceClientOptions);
    this.endpoint = fullyQualifiedNamespace;
    this.endpointWithProtocol = fullyQualifiedNamespace.endsWith("/")
      ? "sb://" + fullyQualifiedNamespace
      : "sb://" + fullyQualifiedNamespace + "/";
    this.credentials = credentials;
    this.namespaceResourceSerializer = new NamespaceResourceSerializer();
    this.queueResourceSerializer = new QueueResourceSerializer();
    this.topicResourceSerializer = new TopicResourceSerializer();
    this.subscriptionResourceSerializer = new SubscriptionResourceSerializer();
    this.ruleResourceSerializer = new RuleResourceSerializer();
  }

  /**
   * Returns an object representing the metadata related to a service bus namespace.
   * @param queueName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   */
  async getNamespaceProperties(
    operationOptions?: OperationOptions
  ): Promise<NamespacePropertiesResponse> {
    log.httpAtomXml(`Performing management operation - getNamespaceProperties()`);
    const response: HttpOperationResponse = await this.getResource(
      "$namespaceinfo",
      this.namespaceResourceSerializer,
      operationOptions
    );

    return this.buildNamespacePropertiesResponse(response);
  }

  /**
   * Creates a queue with given name, configured using the given options
   * @param queueName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createQueue(queueName: string, operationOptions?: OperationOptions): Promise<QueueResponse>;
  /**
   * Creates a queue configured using the given options
   * @param queue Options to configure the Queue being created.
   * For example, you can configure a queue to support partitions or sessions.
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createQueue(
    queue: QueueDescription,
    operationOptions?: OperationOptions
  ): Promise<QueueResponse>;
  async createQueue(
    queueNameOrOptions: string | QueueDescription,
    operationOptions?: OperationOptions
  ): Promise<QueueResponse> {
    let queue: QueueDescription;
    if (typeof queueNameOrOptions === "string") {
      queue = { name: queueNameOrOptions };
    } else {
      queue = queueNameOrOptions;
    }
    log.httpAtomXml(
      `Performing management operation - createQueue() for "${queue.name}" with options: ${queue}`
    );
    const response: HttpOperationResponse = await this.putResource(
      queue.name,
      buildQueueOptions(queue),
      this.queueResourceSerializer,
      false,
      operationOptions
    );

    return this.buildQueueResponse(response);
  }

  /**
   * Returns an object representing the Queue and its properties.
   * If you want to get the Queue runtime info like message count details, use `getQueueRuntimeProperties` API.
   * @param queueName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getQueue(queueName: string, operationOptions?: OperationOptions): Promise<QueueResponse> {
    log.httpAtomXml(`Performing management operation - getQueue() for "${queueName}"`);
    const response: HttpOperationResponse = await this.getResource(
      queueName,
      this.queueResourceSerializer,
      operationOptions
    );

    return this.buildQueueResponse(response);
  }

  /**
   * Returns an object representing the Queue runtime info like message count details.
   * @param queueName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getQueueRuntimeProperties(
    queueName: string,
    operationOptions?: OperationOptions
  ): Promise<QueueRuntimePropertiesResponse> {
    log.httpAtomXml(`Performing management operation - getQueue() for "${queueName}"`);
    const response: HttpOperationResponse = await this.getResource(
      queueName,
      this.queueResourceSerializer,
      operationOptions
    );

    return this.buildQueueRuntimePropertiesResponse(response);
  }

  /**
   * Returns a list of objects, each representing a Queue along with its properties.
   * If you want to get the runtime info of the queues like message count, use `getQueuesRuntimeProperties` API instead.
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listQueues(
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<QueueDescription>> {
    log.httpAtomXml(`Performing management operation - listQueues() with options: ${options}`);
    const response: HttpOperationResponse = await this.listResources(
      "$Resources/Queues",
      options,
      this.queueResourceSerializer
    );
    return this.buildListQueuesResponse(response);
  }

  private async *listQueuesPage(
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<QueueDescription>> {
    let listResponse;
    do {
      listResponse = await this.listQueues({
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listQueuesAll(
    options: OperationOptions = {}
  ): AsyncIterableIterator<QueueDescription> {
    let marker: string | undefined;
    for await (const segment of this.listQueuesPage(marker, options)) {
      yield* segment;
    }
  }

  /**
   * Returns an async iterable iterator to list all the queues.
   *
   * .byPage() returns an async iterable iterator to list the queues in pages.
   *
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<
   *     QueueDescription,
   *     EntitiesResponse<QueueDescription>,
   *   >} An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getQueues(
    options?: OperationOptions
  ): PagedAsyncIterableIterator<QueueDescription, EntitiesResponse<QueueDescription>> {
    log.httpAtomXml(`Performing management operation - listQueues() with options: ${options}`);
    const iter = this.listQueuesAll(options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listQueuesPage(settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Returns a list of objects, each representing a Queue's runtime info like message count details.
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listQueuesRuntimeProperties(
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<QueueRuntimeProperties>> {
    log.httpAtomXml(
      `Performing management operation - listQueuesRuntimeProperties() with options: ${options}`
    );
    const response: HttpOperationResponse = await this.listResources(
      "$Resources/Queues",
      options,
      this.queueResourceSerializer
    );

    return this.buildListQueuesRuntimePropertiesResponse(response);
  }

  private async *listQueuesRuntimePropertiesPage(
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<QueueRuntimeProperties>> {
    let listResponse;
    do {
      listResponse = await this.listQueuesRuntimeProperties({
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listQueuesRuntimePropertiesAll(
    options: OperationOptions = {}
  ): AsyncIterableIterator<QueueRuntimeProperties> {
    let marker: string | undefined;
    for await (const segment of this.listQueuesRuntimePropertiesPage(marker, options)) {
      yield* segment;
    }
  }

  /**
   * Returns an async iterable iterator to list runtime info of the queues.
   *
   * .byPage() returns an async iterable iterator to list runtime info of the queues in pages.
   *
   *
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<
   *     QueueRuntimeProperties,
   *     EntitiesResponse<QueueRuntimeProperties>,
   *   >} An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getQueuesRuntimeProperties(
    options?: OperationOptions
  ): PagedAsyncIterableIterator<QueueRuntimeProperties, EntitiesResponse<QueueRuntimeProperties>> {
    log.httpAtomXml(
      `Performing management operation - getQueuesRuntimeProperties() with options: ${options}`
    );
    const iter = this.listQueuesRuntimePropertiesAll(options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listQueuesRuntimePropertiesPage(settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Updates the queue based on the queue description provided.
   * All properties on the queue description must be set even though only a subset of them are actually updatable.
   * Therefore, the suggested flow is to use `getQueue()` to get the queue description with all properties set,
   * update as needed and then pass it to `updateQueue()`.
   * See https://docs.microsoft.com/en-us/rest/api/servicebus/update-queue for more details.
   *
   * @param queue Object representing the queue with one or more of the below properties updated
   * - defaultMessageTimeToLive
   * - lockDuration
   * - deadLetteringOnMessageExpiration
   * - duplicateDetectionHistoryTimeWindow
   * - maxDeliveryCount
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async updateQueue(
    queue: QueueDescription,
    operationOptions?: OperationOptions
  ): Promise<QueueResponse> {
    log.httpAtomXml(
      `Performing management operation - updateQueue() for "${queue.name}" with options: ${queue}`
    );

    if (!isJSONLikeObject(queue) || queue == null) {
      throw new TypeError(
        `Parameter "queue" must be an object of type "QueueDescription" and cannot be undefined or null.`
      );
    }

    if (!queue.name) {
      throw new TypeError(`"name" attribute of the parameter "queue" cannot be undefined.`);
    }

    const response: HttpOperationResponse = await this.putResource(
      queue.name,
      buildQueueOptions(queue),
      this.queueResourceSerializer,
      true,
      operationOptions
    );

    return this.buildQueueResponse(response);
  }

  /**
   * Deletes a queue.
   * @param queueName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async deleteQueue(queueName: string, operationOptions?: OperationOptions): Promise<Response> {
    log.httpAtomXml(`Performing management operation - deleteQueue() for "${queueName}"`);
    const response: HttpOperationResponse = await this.deleteResource(
      queueName,
      this.queueResourceSerializer,
      operationOptions
    );

    return { _response: response };
  }

  /**
   * Checks whether a given queue exists or not.
   * @param queueName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   */
  async queueExists(queueName: string, operationOptions?: OperationOptions): Promise<boolean> {
    log.httpAtomXml(`Performing management operation - queueExists() for "${queueName}"`);
    try {
      await this.getQueue(queueName, operationOptions);
    } catch (error) {
      if (error.code == "MessageEntityNotFoundError") {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Creates a topic with given name, configured using the given options
   * @param topicName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createTopic(topicName: string, operationOptions?: OperationOptions): Promise<TopicResponse>;
  /**
   * Creates a topic with given name, configured using the given options
   * @param topic Options to configure the Topic being created.
   * For example, you can configure a topic to support partitions or sessions.
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createTopic(
    topic: TopicDescription,
    operationOptions?: OperationOptions
  ): Promise<TopicResponse>;
  async createTopic(
    topicNameOrOptions: string | TopicDescription,
    operationOptions?: OperationOptions
  ): Promise<TopicResponse> {
    let topic: TopicDescription;
    if (typeof topicNameOrOptions === "string") {
      topic = { name: topicNameOrOptions };
    } else {
      topic = topicNameOrOptions;
    }
    log.httpAtomXml(
      `Performing management operation - createTopic() for "${topic.name}" with options: ${topic}`
    );
    const response: HttpOperationResponse = await this.putResource(
      topic.name,
      buildTopicOptions(topic),
      this.topicResourceSerializer,
      false,
      operationOptions
    );

    return this.buildTopicResponse(response);
  }

  /**
   * Returns an object representing the Topic and its properties.
   * If you want to get the Topic runtime info like subscription count details, use `getTopicRuntimeProperties` API.
   * @param topicName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getTopic(topicName: string, operationOptions?: OperationOptions): Promise<TopicResponse> {
    log.httpAtomXml(`Performing management operation - getTopic() for "${topicName}"`);
    const response: HttpOperationResponse = await this.getResource(
      topicName,
      this.topicResourceSerializer,
      operationOptions
    );

    return this.buildTopicResponse(response);
  }

  /**
   * Returns an object representing the Topic runtime info like subscription count.
   * @param topicName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getTopicRuntimeProperties(
    topicName: string,
    operationOptions?: OperationOptions
  ): Promise<TopicRuntimePropertiesResponse> {
    log.httpAtomXml(`Performing management operation - getTopicRuntimeProperties() for "${topicName}"`);
    const response: HttpOperationResponse = await this.getResource(
      topicName,
      this.topicResourceSerializer,
      operationOptions
    );

    return this.buildTopicRuntimePropertiesResponse(response);
  }

  /**
   * Returns a list of objects, each representing a Topic along with its properties.
   * If you want to get the runtime info of the topics like subscription count, use `getTopicsRuntimeProperties` API instead.
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listTopics(
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<TopicDescription>> {
    log.httpAtomXml(`Performing management operation - listTopics() with options: ${options}`);
    const response: HttpOperationResponse = await this.listResources(
      "$Resources/Topics",
      options,
      this.topicResourceSerializer
    );

    return this.buildListTopicsResponse(response);
  }

  private async *listTopicsPage(
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<TopicDescription>> {
    let listResponse;
    do {
      listResponse = await this.listTopics({
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listTopicsAll(
    options: OperationOptions = {}
  ): AsyncIterableIterator<TopicDescription> {
    let marker: string | undefined;
    for await (const segment of this.listTopicsPage(marker, options)) {
      yield* segment;
    }
  }

  /**
   * Returns an async iterable iterator to list all the topics.
   *
   * .byPage() returns an async iterable iterator to list the topics in pages.
   *
   *
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<
   *     TopicDescription,
   *     EntitiesResponse<TopicDescription>,
   *   >} An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getTopics(
    options?: OperationOptions
  ): PagedAsyncIterableIterator<TopicDescription, EntitiesResponse<TopicDescription>> {
    log.httpAtomXml(`Performing management operation - getTopics() with options: ${options}`);
    const iter = this.listTopicsAll(options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listTopicsPage(settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Returns a list of objects, each representing a Topic's runtime info like subscription count.
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listTopicsRuntimeProperties(
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<TopicRuntimeProperties>> {
    log.httpAtomXml(`Performing management operation - listTopics() with options: ${options}`);
    const response: HttpOperationResponse = await this.listResources(
      "$Resources/Topics",
      options,
      this.topicResourceSerializer
    );

    return this.buildListTopicsRuntimePropertiesResponse(response);
  }

  private async *listTopicsRuntimePropertiesPage(
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<TopicRuntimeProperties>> {
    let listResponse;
    do {
      listResponse = await this.listTopicsRuntimeProperties({
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listTopicsRuntimePropertiesAll(
    options: OperationOptions = {}
  ): AsyncIterableIterator<TopicRuntimeProperties> {
    let marker: string | undefined;
    for await (const segment of this.listTopicsRuntimePropertiesPage(marker, options)) {
      yield* segment;
    }
  }

  /**
   * Returns an async iterable iterator to list runtime info of the topics.
   *
   * .byPage() returns an async iterable iterator to list runtime info of the topics in pages.
   *
   *
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<
   *     TopicRuntimeProperties,
   *     EntitiesResponse<TopicRuntimeProperties>,

   *   >} An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getTopicsRuntimeProperties(
    options?: OperationOptions
  ): PagedAsyncIterableIterator<TopicRuntimeProperties, EntitiesResponse<TopicRuntimeProperties>> {
    log.httpAtomXml(
      `Performing management operation - getTopicsRuntimeProperties() with options: ${options}`
    );
    const iter = this.listTopicsRuntimePropertiesAll(options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listTopicsRuntimePropertiesPage(settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Updates the topic based on the topic description provided.
   * All properties on the topic description must be set even though only a subset of them are actually updatable.
   * Therefore, the suggested flow is to use `getTopic()` to get the topic description with all properties set,
   * update as needed and then pass it to `updateTopic()`.
   * See https://docs.microsoft.com/en-us/rest/api/servicebus/update-topic for more details.
   *
   * @param topic Object representing the topic with one or more of the below properties updated
   *   - defaultMessageTimeToLive
   *   - duplicateDetectionHistoryTimeWindow
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async updateTopic(
    topic: TopicDescription,
    operationOptions?: OperationOptions
  ): Promise<TopicResponse> {
    log.httpAtomXml(
      `Performing management operation - updateTopic() for "${topic.name}" with options: ${topic}`
    );

    if (!isJSONLikeObject(topic) || topic == null) {
      throw new TypeError(
        `Parameter "topic" must be an object of type "TopicDescription" and cannot be undefined or null.`
      );
    }

    if (!topic.name) {
      throw new TypeError(`"name" attribute of the parameter "topic" cannot be undefined.`);
    }

    const response: HttpOperationResponse = await this.putResource(
      topic.name,
      buildTopicOptions(topic),
      this.topicResourceSerializer,
      true,
      operationOptions
    );

    return this.buildTopicResponse(response);
  }

  /**
   * Deletes a topic.
   * @param topicName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async deleteTopic(topicName: string, operationOptions?: OperationOptions): Promise<Response> {
    log.httpAtomXml(`Performing management operation - deleteTopic() for "${topicName}"`);
    const response: HttpOperationResponse = await this.deleteResource(
      topicName,
      this.topicResourceSerializer,
      operationOptions
    );

    return { _response: response };
  }

  /**
   * Checks whether a given topic exists or not.
   * @param topicName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   */
  async topicExists(topicName: string, operationOptions?: OperationOptions): Promise<boolean> {
    log.httpAtomXml(`Performing management operation - topicExists() for "${topicName}"`);
    try {
      await this.getTopic(topicName, operationOptions);
    } catch (error) {
      if (error.code == "MessageEntityNotFoundError") {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Creates a subscription with given name, configured using the given options
   * @param topicName
   * @param subscriptionName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createSubscription(
    topicName: string,
    subscriptionName: string,
    operationOptions?: OperationOptions
  ): Promise<SubscriptionResponse>;

  /**
   * Creates a subscription with given name, configured using the given options
   * @param subscription Options to configure the Subscription being created.
   * For example, you can configure a Subscription to support partitions or sessions.
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createSubscription(
    subscription: SubscriptionDescription,
    operationOptions?: OperationOptions
  ): Promise<SubscriptionResponse>;
  async createSubscription(
    topicNameOrSubscriptionOptions: string | SubscriptionDescription,
    subscriptionNameOrOperationOptions?: string | OperationOptions,
    operationOptions?: OperationOptions
  ): Promise<SubscriptionResponse> {
    let subscription: SubscriptionDescription;
    let operOptions: OperationOptions | undefined;
    if (typeof subscriptionNameOrOperationOptions === "string") {
      if (typeof topicNameOrSubscriptionOptions !== "string") {
        throw new Error("Topic name provided is invalid");
      }
      subscription = {
        topicName: topicNameOrSubscriptionOptions,
        subscriptionName: subscriptionNameOrOperationOptions
      };
      operOptions = operationOptions;
    } else {
      subscription = topicNameOrSubscriptionOptions as SubscriptionDescription;
      operOptions = subscriptionNameOrOperationOptions;
    }
    log.httpAtomXml(
      `Performing management operation - createSubscription() for "${subscription.subscriptionName}" with options: ${subscription}`
    );
    const fullPath = this.getSubscriptionPath(
      subscription.topicName,
      subscription.subscriptionName
    );
    const response: HttpOperationResponse = await this.putResource(
      fullPath,
      buildSubscriptionOptions(subscription),
      this.subscriptionResourceSerializer,
      false,
      operOptions
    );

    return this.buildSubscriptionResponse(response);
  }

  /**
   * Returns an object representing the Subscription and its properties.
   * If you want to get the Subscription runtime info like message count details, use `getSubscriptionRuntimeProperties` API.
   * @param topicName
   * @param subscriptionName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getSubscription(
    topicName: string,
    subscriptionName: string,
    operationOptions?: OperationOptions
  ): Promise<SubscriptionResponse> {
    log.httpAtomXml(
      `Performing management operation - getSubscription() for "${subscriptionName}"`
    );
    const fullPath = this.getSubscriptionPath(topicName, subscriptionName);
    const response: HttpOperationResponse = await this.getResource(
      fullPath,
      this.subscriptionResourceSerializer,
      operationOptions
    );

    return this.buildSubscriptionRuntimePropertiesResponse(response);
  }

  /**
   * Returns an object representing the Subscription runtime info like message count details.
   * @param topicName
   * @param subscriptionName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getSubscriptionRuntimeProperties(
    topicName: string,
    subscriptionName: string,
    operationOptions?: OperationOptions
  ): Promise<SubscriptionRuntimePropertiesResponse> {
    log.httpAtomXml(
      `Performing management operation - getSubscription() for "${subscriptionName}"`
    );
    const fullPath = this.getSubscriptionPath(topicName, subscriptionName);
    const response: HttpOperationResponse = await this.getResource(
      fullPath,
      this.subscriptionResourceSerializer,
      operationOptions
    );

    return this.buildSubscriptionRuntimePropertiesResponse(response);
  }

  /**
   * Returns a list of objects, each representing a Subscription along with its properties.
   * If you want to get the runtime info of the subscriptions like message count, use `getSubscriptionsRuntimeProperties` API instead.
   * @param topicName
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listSubscriptions(
    topicName: string,
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<SubscriptionDescription>> {
    log.httpAtomXml(
      `Performing management operation - listSubscriptions() with options: ${options}`
    );
    const response: HttpOperationResponse = await this.listResources(
      topicName + "/Subscriptions/",
      options,
      this.subscriptionResourceSerializer
    );

    return this.buildListSubscriptionsResponse(response);
  }

  private async *listSubscriptionsPage(
    topicName: string,
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<SubscriptionDescription>> {
    let listResponse;
    do {
      listResponse = await this.listSubscriptions(topicName, {
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listSubscriptionsAll(
    topicName: string,
    options: OperationOptions = {}
  ): AsyncIterableIterator<SubscriptionDescription> {
    let marker: string | undefined;
    for await (const segment of this.listSubscriptionsPage(topicName, marker, options)) {
      yield* segment;
    }
  }

  /**
   *
   * Returns an async iterable iterator to list all the subscriptions
   * under the specified topic.
   *
   * .byPage() returns an async iterable iterator to list the subscriptions in pages.
   *
   * @memberof ServiceBusManagementClient
   * @param {string} topicName
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<
   *     SubscriptionDescription,
   *     EntitiesResponse<SubscriptionDescription>
   *   >} An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getSubscriptions(
    topicName: string,
    options?: OperationOptions
  ): PagedAsyncIterableIterator<
    SubscriptionDescription,
    EntitiesResponse<SubscriptionDescription>
  > {
    log.httpAtomXml(
      `Performing management operation - getSubscriptions() with options: ${options}`
    );
    const iter = this.listSubscriptionsAll(topicName, options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listSubscriptionsPage(topicName, settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Returns a list of objects, each representing a Subscription's runtime info like message count details.
   * @param topicName
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listSubscriptionsRuntimeProperties(
    topicName: string,
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<SubscriptionRuntimeProperties>> {
    log.httpAtomXml(
      `Performing management operation - listSubscriptionsRuntimeProperties() with options: ${options}`
    );
    const response: HttpOperationResponse = await this.listResources(
      topicName + "/Subscriptions/",
      options,
      this.subscriptionResourceSerializer
    );

    return this.buildListSubscriptionsRuntimePropertiesResponse(response);
  }

  private async *listSubscriptionsRuntimePropertiesPage(
    topicName: string,
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<SubscriptionRuntimeProperties>> {
    let listResponse;
    do {
      listResponse = await this.listSubscriptionsRuntimeProperties(topicName, {
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listSubscriptionsRuntimePropertiesAll(
    topicName: string,
    options: OperationOptions = {}
  ): AsyncIterableIterator<SubscriptionRuntimeProperties> {
    let marker: string | undefined;
    for await (const segment of this.listSubscriptionsRuntimePropertiesPage(topicName, marker, options)) {
      yield* segment;
    }
  }

  /**
   * Returns an async iterable iterator to list runtime info of the subscriptions
   * under the specified topic.
   *
   * .byPage() returns an async iterable iterator to list runtime info of subscriptions in pages.
   *
   * @param {string} topicName
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<
   *     SubscriptionRuntimeProperties,
   *     EntitiesResponse<SubscriptionRuntimeProperties>,

   *   >}  An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getSubscriptionsRuntimeProperties(
    topicName: string,
    options?: OperationOptions
  ): PagedAsyncIterableIterator<
    SubscriptionRuntimeProperties,
    EntitiesResponse<SubscriptionRuntimeProperties>
  > {
    log.httpAtomXml(
      `Performing management operation - getSubscriptionsRuntimeProperties() with options: ${options}`
    );
    const iter = this.listSubscriptionsRuntimePropertiesAll(topicName, options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listSubscriptionsRuntimePropertiesPage(topicName, settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Updates the subscription based on the subscription description provided.
   * All properties on the subscription description must be set even though only a subset of them are actually updatable.
   * Therefore, the suggested flow is to use `getSubscription()` to get the subscription description with all properties set,
   * update as needed and then pass it to `updateSubscription()`.
   *
   * @param subscription Object representing the subscription with one or more of the below properties updated
   *   - lockDuration
   *   - deadLetteringOnMessageExpiration
   *   - maxDeliveryCount
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async updateSubscription(
    subscription: SubscriptionDescription,
    operationOptions?: OperationOptions
  ): Promise<SubscriptionResponse> {
    log.httpAtomXml(
      `Performing management operation - updateSubscription() for "${subscription.subscriptionName}" with options: ${subscription}`
    );

    if (!isJSONLikeObject(subscription) || subscription == null) {
      throw new TypeError(
        `Parameter "subscription" must be an object of type "SubscriptionDescription" and cannot be undefined or null.`
      );
    }

    if (!subscription.topicName || !subscription.subscriptionName) {
      throw new TypeError(
        `The attributes "topicName" and "subscriptionName" of the parameter "subscription" cannot be undefined.`
      );
    }

    const fullPath = this.getSubscriptionPath(
      subscription.topicName,
      subscription.subscriptionName
    );

    const response: HttpOperationResponse = await this.putResource(
      fullPath,
      buildSubscriptionOptions(subscription),
      this.subscriptionResourceSerializer,
      true,
      operationOptions
    );

    return this.buildSubscriptionResponse(response);
  }

  /**
   * Deletes a subscription.
   * @param topicName
   * @param subscriptionName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async deleteSubscription(
    topicName: string,
    subscriptionName: string,
    operationOptions?: OperationOptions
  ): Promise<Response> {
    log.httpAtomXml(
      `Performing management operation - deleteSubscription() for "${subscriptionName}"`
    );
    const fullPath = this.getSubscriptionPath(topicName, subscriptionName);
    const response: HttpOperationResponse = await this.deleteResource(
      fullPath,
      this.subscriptionResourceSerializer,
      operationOptions
    );

    return { _response: response };
  }

  /**
   * Checks whether a given subscription exists in the topic or not.
   * @param topicName
   * @param subscriptionName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   */
  async subscriptionExists(
    topicName: string,
    subscriptionName: string,
    operationOptions?: OperationOptions
  ): Promise<boolean> {
    log.httpAtomXml(
      `Performing management operation - subscriptionExists() for "${topicName}" and "${subscriptionName}"`
    );
    try {
      await this.getSubscription(topicName, subscriptionName, operationOptions);
    } catch (error) {
      if (error.code == "MessageEntityNotFoundError") {
        return false;
      }
      throw error;
    }
    return true;
  }

  /**
   * Creates a rule with given name, configured using the given options.
   * @param topicName
   * @param subscriptionName
   * @param rule
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityAlreadyExistsError` when requested messaging entity already exists,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `QuotaExceededError` when requested operation fails due to quote limits exceeding from service side,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async createRule(
    topicName: string,
    subscriptionName: string,
    rule: RuleDescription,
    operationOptions?: OperationOptions
  ): Promise<RuleResponse> {
    log.httpAtomXml(
      `Performing management operation - createRule() for "${rule.name}" with options: "${rule}"`
    );
    const fullPath = this.getRulePath(topicName, subscriptionName, rule.name);
    const response: HttpOperationResponse = await this.putResource(
      fullPath,
      rule,
      this.ruleResourceSerializer,
      false,
      operationOptions
    );
    return this.buildRuleResponse(response);
  }

  /**
   * Returns an object representing the Rule with the given name along with all its properties.
   * @param topicName
   * @param subscriptionName
   * @param ruleName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async getRule(
    topicName: string,
    subscriptionName: string,
    ruleName: string,
    operationOptions?: OperationOptions
  ): Promise<RuleResponse> {
    log.httpAtomXml(`Performing management operation - getRule() for "${ruleName}"`);
    const fullPath = this.getRulePath(topicName, subscriptionName, ruleName);
    const response: HttpOperationResponse = await this.getResource(
      fullPath,
      this.ruleResourceSerializer,
      operationOptions
    );

    return this.buildRuleResponse(response);
  }

  /**
   * Lists existing rules.
   * @param topicName
   * @param subscriptionName
   * @param options The options include the maxCount and the count of entities to skip, the operation options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  private async listRules(
    topicName: string,
    subscriptionName: string,
    options?: ListRequestOptions & OperationOptions
  ): Promise<EntitiesResponse<RuleDescription>> {
    log.httpAtomXml(`Performing management operation - listRules() with options: ${options}`);
    const fullPath = this.getSubscriptionPath(topicName, subscriptionName) + "/Rules/";
    const response: HttpOperationResponse = await this.listResources(
      fullPath,
      options,
      this.ruleResourceSerializer
    );

    return this.buildListRulesResponse(response);
  }

  private async *listRulesPage(
    topicName: string,
    subscriptionName: string,
    marker?: string,
    options: OperationOptions & Pick<PageSettings, "maxPageSize"> = {}
  ): AsyncIterableIterator<EntitiesResponse<RuleDescription>> {
    let listResponse;
    do {
      listResponse = await this.listRules(topicName, subscriptionName, {
        skip: Number(marker),
        maxCount: options.maxPageSize,
        ...options
      });
      marker = listResponse.continuationToken;
      yield listResponse;
    } while (marker);
  }

  private async *listRulesAll(
    topicName: string,
    subscriptionName: string,
    options: OperationOptions = {}
  ): AsyncIterableIterator<RuleDescription> {
    let marker: string | undefined;
    for await (const segment of this.listRulesPage(topicName, subscriptionName, marker, options)) {
      yield* segment;
    }
  }

  /**
   * Returns an async iterable iterator to list all the rules
   * under the specified subscription.
   *
   * .byPage() returns an async iterable iterator to list the rules in pages.
   *
   * @param {string} topicName
   * @param {string} subscriptionName
   * @param {OperationOptions} [options]
   * @returns {PagedAsyncIterableIterator<RuleDescription, EntitiesResponse<RuleDescription>>} An asyncIterableIterator that supports paging.
   * @memberof ServiceBusManagementClient
   */
  public getRules(
    topicName: string,
    subscriptionName: string,
    options?: OperationOptions
  ): PagedAsyncIterableIterator<RuleDescription, EntitiesResponse<RuleDescription>> {
    log.httpAtomXml(`Performing management operation - getRules() with options: ${options}`);
    const iter = this.listRulesAll(topicName, subscriptionName, options);
    return {
      /**
       * @member {Promise} [next] The next method, part of the iteration protocol
       */
      next() {
        return iter.next();
      },
      /**
       * @member {Symbol} [asyncIterator] The connection to the async iterator, part of the iteration protocol
       */
      [Symbol.asyncIterator]() {
        return this;
      },
      /**
       * @member {Function} [byPage] Return an AsyncIterableIterator that works a page at a time
       */
      byPage: (settings: PageSettings = {}) => {
        this.throwIfInvalidContinuationToken(settings.continuationToken);
        return this.listRulesPage(topicName, subscriptionName, settings.continuationToken, {
          maxPageSize: settings.maxPageSize,
          ...options
        });
      }
    };
  }

  /**
   * Updates properties on the Rule by the given name based on the given options.
   * @param topicName
   * @param subscriptionName
   * @param rule Options to configure the Rule being updated.
   * For example, you can configure the filter to apply on associated Topic/Subscription.
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async updateRule(
    topicName: string,
    subscriptionName: string,
    rule: RuleDescription,
    operationOptions?: OperationOptions
  ): Promise<RuleResponse> {
    log.httpAtomXml(
      `Performing management operation - updateRule() for "${rule.name}" with options: ${rule}`
    );

    if (!isJSONLikeObject(rule) || rule === null) {
      throw new TypeError(
        `Parameter "rule" must be an object of type "RuleDescription" and cannot be undefined or null.`
      );
    }

    if (!rule.name) {
      throw new TypeError(`"name" attribute of the parameter "rule" cannot be undefined.`);
    }

    const fullPath = this.getRulePath(topicName, subscriptionName, rule.name);
    const response: HttpOperationResponse = await this.putResource(
      fullPath,
      rule,
      this.ruleResourceSerializer,
      true,
      operationOptions
    );

    return this.buildRuleResponse(response);
  }

  /**
   * Deletes a rule.
   * @param topicName
   * @param subscriptionName
   * @param ruleName
   * @param operationOptions The options that can be used to abort, trace and control other configurations on the HTTP request.
   *
   * Following are errors that can be expected from this operation
   * @throws `RestError` with code `UnauthorizedRequestError` when given request fails due to authorization problems,
   * @throws `RestError` with code `MessageEntityNotFoundError` when requested messaging entity does not exist,
   * @throws `RestError` with code `InvalidOperationError` when requested operation is invalid and we encounter a 403 HTTP status code,
   * @throws `RestError` with code `ServerBusyError` when the request fails due to server being busy,
   * @throws `RestError` with code `ServiceError` when receiving unrecognized HTTP status or for a scenarios such as
   * bad requests or requests resulting in conflicting operation on the server,
   * @throws `RestError` with code that is a value from the standard set of HTTP status codes as documented at
   * https://docs.microsoft.com/en-us/dotnet/api/system.net.httpstatuscode?view=netframework-4.8
   */
  async deleteRule(
    topicName: string,
    subscriptionName: string,
    ruleName: string,
    operationOptions?: OperationOptions
  ): Promise<Response> {
    log.httpAtomXml(`Performing management operation - deleteRule() for "${ruleName}"`);
    const fullPath = this.getRulePath(topicName, subscriptionName, ruleName);
    const response: HttpOperationResponse = await this.deleteResource(
      fullPath,
      this.ruleResourceSerializer,
      operationOptions
    );

    return { _response: response };
  }

  /**
   * Creates or updates a resource based on `isUpdate` parameter.
   * @param name
   * @param entityFields
   * @param isUpdate
   * @param serializer
   */
  private async putResource(
    name: string,
    entityFields:
      | InternalQueueOptions
      | InternalTopicOptions
      | InternalSubscriptionOptions
      | RuleDescription,
    serializer: AtomXmlSerializer,
    isUpdate: boolean = false,
    operationOptions: OperationOptions = {}
  ): Promise<HttpOperationResponse> {
    const webResource: WebResource = new WebResource(this.getUrl(name), "PUT");
    webResource.body = entityFields;
    if (isUpdate) {
      webResource.headers.set("If-Match", "*");
    }

    const queueOrSubscriptionFields = entityFields as
      | InternalQueueOptions
      | InternalSubscriptionOptions;
    if (
      queueOrSubscriptionFields.ForwardTo ||
      queueOrSubscriptionFields.ForwardDeadLetteredMessagesTo
    ) {
      const token =
        this.credentials instanceof SasServiceClientCredentials
          ? this.credentials.getToken(this.endpoint).token
          : (await this.credentials.getToken([AMQPConstants.aadServiceBusScope]))!.token;

      if (queueOrSubscriptionFields.ForwardTo) {
        webResource.headers.set("ServiceBusSupplementaryAuthorization", token);
        if (!isAbsoluteUrl(queueOrSubscriptionFields.ForwardTo)) {
          queueOrSubscriptionFields.ForwardTo = this.endpointWithProtocol.concat(
            queueOrSubscriptionFields.ForwardTo
          );
        }
      }
      if (queueOrSubscriptionFields.ForwardDeadLetteredMessagesTo) {
        webResource.headers.set("ServiceBusDlqSupplementaryAuthorization", token);
        if (!isAbsoluteUrl(queueOrSubscriptionFields.ForwardDeadLetteredMessagesTo)) {
          queueOrSubscriptionFields.ForwardDeadLetteredMessagesTo = this.endpointWithProtocol.concat(
            queueOrSubscriptionFields.ForwardDeadLetteredMessagesTo
          );
        }
      }
    }

    webResource.headers.set("content-type", "application/atom+xml;type=entry;charset=utf-8");

    return executeAtomXmlOperation(this, webResource, serializer, operationOptions);
  }

  /**
   * Gets a resource.
   * @param name
   * @param serializer
   */
  private async getResource(
    name: string,
    serializer: AtomXmlSerializer,
    operationOptions: OperationOptions = {}
  ): Promise<HttpOperationResponse> {
    const webResource: WebResource = new WebResource(this.getUrl(name), "GET");

    const response = await executeAtomXmlOperation(this, webResource, serializer, operationOptions);
    if (
      response.parsedBody == undefined ||
      (Array.isArray(response.parsedBody) && response.parsedBody.length == 0)
    ) {
      const err = new RestError(
        `The messaging entity "${name}" being requested cannot be found.`,
        "MessageEntityNotFoundError",
        404,
        stripRequest(webResource),
        stripResponse(response)
      );
      throw err;
    }
    return response;
  }

  /**
   * Lists existing resources
   * @param name
   * @param listRequestOptions
   * @param serializer
   */
  private async listResources(
    name: string,
    listRequestOptions: ListRequestOptions & OperationOptions = {},
    serializer: AtomXmlSerializer
  ): Promise<HttpOperationResponse> {
    const queryParams: { [key: string]: string } = {};
    if (listRequestOptions) {
      if (listRequestOptions.skip) {
        queryParams["$skip"] = listRequestOptions.skip.toString();
      }
      if (listRequestOptions.maxCount) {
        queryParams["$top"] = listRequestOptions.maxCount.toString();
      }
    }

    const webResource: WebResource = new WebResource(this.getUrl(name, queryParams), "GET");

    return executeAtomXmlOperation(this, webResource, serializer, listRequestOptions);
  }

  /**
   * Deletes a resource.
   * @param name
   */
  private async deleteResource(
    name: string,
    serializer: AtomXmlSerializer,
    operationOptions: OperationOptions = {}
  ): Promise<HttpOperationResponse> {
    const webResource: WebResource = new WebResource(this.getUrl(name), "DELETE");

    return executeAtomXmlOperation(this, webResource, serializer, operationOptions);
  }

  private getUrl(path: string, queryParams?: { [key: string]: string }): string {
    const baseUri = `https://${this.endpoint}/${path}`;

    const requestUrl: URLBuilder = URLBuilder.parse(baseUri);
    requestUrl.setQueryParameter(Constants.API_VERSION_QUERY_KEY, Constants.CURRENT_API_VERSION);

    if (queryParams) {
      for (const key of Object.keys(queryParams)) {
        requestUrl.setQueryParameter(key, queryParams[key]);
      }
    }

    return requestUrl.toString();
  }

  private getSubscriptionPath(topicName: string, subscriptionName: string): string {
    return topicName + "/Subscriptions/" + subscriptionName;
  }

  private getRulePath(topicName: string, subscriptionName: string, ruleName: string): string {
    return topicName + "/Subscriptions/" + subscriptionName + "/Rules/" + ruleName;
  }

  private getMarkerFromNextLinkUrl(url: string): string | undefined {
    if (!url) {
      return undefined;
    }
    try {
      return parseURL(url).searchParams.get(Constants.XML_METADATA_MARKER + "skip");
    } catch (error) {
      throw new Error(
        `Unable to parse the '${Constants.XML_METADATA_MARKER}skip' from the next-link in the response ` +
          error
      );
    }
  }

  private buildNamespacePropertiesResponse(
    response: HttpOperationResponse
  ): NamespacePropertiesResponse {
    try {
      const namespace = buildNamespace(response.parsedBody);
      const namespaceResponse: NamespacePropertiesResponse = Object.assign(namespace || {}, {
        _response: response
      });
      return namespaceResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a namespace object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListQueuesResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<QueueDescription> {
    try {
      const queues: QueueDescription[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawQueueArray: any = response.parsedBody;
      for (let i = 0; i < rawQueueArray.length; i++) {
        const queue = buildQueue(rawQueueArray[i]);
        if (queue) {
          queues.push(queue);
        }
      }
      const listQueuesResponse: EntitiesResponse<QueueDescription> = Object.assign(queues, {
        _response: response
      });
      listQueuesResponse.continuationToken = nextMarker;
      return listQueuesResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of queues using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListQueuesRuntimePropertiesResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<QueueRuntimeProperties> {
    try {
      const queues: QueueRuntimeProperties[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawQueueArray: any = response.parsedBody;
      for (let i = 0; i < rawQueueArray.length; i++) {
        const queue = buildQueueRuntimeProperties(rawQueueArray[i]);
        if (queue) {
          queues.push(queue);
        }
      }
      const listQueuesResponse: EntitiesResponse<QueueRuntimeProperties> = Object.assign(queues, {
        _response: response
      });
      listQueuesResponse.continuationToken = nextMarker;
      return listQueuesResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of queues using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildQueueResponse(response: HttpOperationResponse): QueueResponse {
    try {
      const queue = buildQueue(response.parsedBody);
      const queueResponse: QueueResponse = Object.assign(queue || {}, {
        _response: response
      });
      return queueResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a queue object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildQueueRuntimePropertiesResponse(response: HttpOperationResponse): QueueRuntimePropertiesResponse {
    try {
      const queue = buildQueueRuntimeProperties(response.parsedBody);
      const queueResponse: QueueRuntimePropertiesResponse = Object.assign(queue || {}, {
        _response: response
      });
      return queueResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a queue object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListTopicsResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<TopicDescription> {
    try {
      const topics: TopicDescription[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawTopicArray: any = response.parsedBody;
      for (let i = 0; i < rawTopicArray.length; i++) {
        const topic = buildTopic(rawTopicArray[i]);
        if (topic) {
          topics.push(topic);
        }
      }
      const listTopicsResponse: EntitiesResponse<TopicDescription> = Object.assign(topics, {
        _response: response
      });
      listTopicsResponse.continuationToken = nextMarker;
      return listTopicsResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of topics using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListTopicsRuntimePropertiesResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<TopicRuntimeProperties> {
    try {
      const topics: TopicRuntimeProperties[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawTopicArray: any = response.parsedBody;
      for (let i = 0; i < rawTopicArray.length; i++) {
        const topic = buildTopicRuntimeProperties(rawTopicArray[i]);
        if (topic) {
          topics.push(topic);
        }
      }
      const listTopicsResponse: EntitiesResponse<TopicRuntimeProperties> = Object.assign(topics, {
        _response: response
      });
      listTopicsResponse.continuationToken = nextMarker;
      return listTopicsResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of topics using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }
  private buildTopicResponse(response: HttpOperationResponse): TopicResponse {
    try {
      const topic = buildTopic(response.parsedBody);
      const topicResponse: TopicResponse = Object.assign(topic || {}, {
        _response: response
      });
      return topicResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a topic object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildTopicRuntimePropertiesResponse(response: HttpOperationResponse): TopicRuntimePropertiesResponse {
    try {
      const topic = buildTopicRuntimeProperties(response.parsedBody);
      const topicResponse: TopicRuntimePropertiesResponse = Object.assign(topic || {}, {
        _response: response
      });
      return topicResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a topic object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListSubscriptionsResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<SubscriptionDescription> {
    try {
      const subscriptions: SubscriptionDescription[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawSubscriptionArray: any = response.parsedBody;
      for (let i = 0; i < rawSubscriptionArray.length; i++) {
        const subscription = buildSubscription(rawSubscriptionArray[i]);
        if (subscription) {
          subscriptions.push(subscription);
        }
      }
      const listSubscriptionsResponse: EntitiesResponse<SubscriptionDescription> = Object.assign(
        subscriptions,
        {
          _response: response
        }
      );
      listSubscriptionsResponse.continuationToken = nextMarker;
      return listSubscriptionsResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of subscriptions using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListSubscriptionsRuntimePropertiesResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<SubscriptionRuntimeProperties> {
    try {
      const subscriptions: SubscriptionRuntimeProperties[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawSubscriptionArray: any = response.parsedBody;
      for (let i = 0; i < rawSubscriptionArray.length; i++) {
        const subscription = buildSubscriptionRuntimeProperties(rawSubscriptionArray[i]);
        if (subscription) {
          subscriptions.push(subscription);
        }
      }
      const listSubscriptionsResponse: EntitiesResponse<SubscriptionRuntimeProperties> = Object.assign(
        subscriptions,
        {
          _response: response
        }
      );
      listSubscriptionsResponse.continuationToken = nextMarker;
      return listSubscriptionsResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of subscriptions using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildSubscriptionResponse(response: HttpOperationResponse): SubscriptionResponse {
    try {
      const subscription = buildSubscription(response.parsedBody);
      const subscriptionResponse: SubscriptionResponse = Object.assign(subscription || {}, {
        _response: response
      });
      return subscriptionResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a subscription object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildSubscriptionRuntimePropertiesResponse(
    response: HttpOperationResponse
  ): SubscriptionRuntimePropertiesResponse {
    try {
      const subscription = buildSubscriptionRuntimeProperties(response.parsedBody);
      const subscriptionResponse: SubscriptionRuntimePropertiesResponse = Object.assign(
        subscription || {},
        {
          _response: response
        }
      );
      return subscriptionResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a subscription object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildListRulesResponse(
    response: HttpOperationResponse
  ): EntitiesResponse<RuleDescription> {
    try {
      const rules: RuleDescription[] = [];
      const nextMarker = this.getMarkerFromNextLinkUrl(response.parsedBody.nextLink);
      if (!Array.isArray(response.parsedBody)) {
        throw new TypeError(`${response.parsedBody} was expected to be of type Array`);
      }
      const rawRuleArray: any = response.parsedBody;
      for (let i = 0; i < rawRuleArray.length; i++) {
        const rule = buildRule(rawRuleArray[i]);
        if (rule) {
          rules.push(rule);
        }
      }
      const listRulesResponse: EntitiesResponse<RuleDescription> = Object.assign(rules, {
        _response: response
      });
      listRulesResponse.continuationToken = nextMarker;
      return listRulesResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a list of rules using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private buildRuleResponse(response: HttpOperationResponse): RuleResponse {
    try {
      const rule = buildRule(response.parsedBody);
      const ruleResponse: RuleResponse = Object.assign(rule || {}, { _response: response });
      return ruleResponse;
    } catch (err) {
      log.warning("Failure parsing response from service - %0 ", err);
      throw new RestError(
        `Error occurred while parsing the response body - cannot form a rule object using the response from the service.`,
        RestError.PARSE_ERROR,
        response.status,
        stripRequest(response.request),
        stripResponse(response)
      );
    }
  }

  private throwIfInvalidContinuationToken(token: string | undefined) {
    if (!(token === undefined || (typeof token === "string" && Number(token) >= 0))) {
      throw new Error(`Invalid continuationToken ${token} provided`);
    }
  }
}
