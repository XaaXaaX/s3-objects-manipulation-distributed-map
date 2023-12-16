import { Construct } from 'constructs';
import { CustomState, Pass, StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';

export class DistributedMapStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const { account: AWS_ACCOUNT_ID, region: AWS_REGION } = Stack.of(this);

    const topic = new Topic(this, 'Topic');
    const inputBucket = new Bucket(this, "InputBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    new BucketDeployment(this, "S3AssetLocalUpload", {
      sources: [Source.asset('../assets')],
      destinationBucket: inputBucket,
    });

    const definition = 
      new CustomState(this, 'S3 Distributed Map State Machine', {
        stateJson: {
          Label: "Map",
          MaxConcurrency: 1000,
          ToleratedFailurePercentage: 100,
          Next: "End",
          Type: "Map",
          Catch: [
            {
              ErrorEquals: [
                "States.ItemReaderFailed"
              ],
              Next: "Fail"
            }
          ],
          ItemBatcher: {
            MaxItemsPerBatch: 5
          },
          ItemProcessor: {
            ProcessorConfig: {
              ExecutionType: "STANDARD",
              Mode: "DISTRIBUTED"
            },
            StartAt: "ProcessObjects",
            States: {
              ProcessObjects: {
                Type: "Map",
                ItemsPath: "$.Items",
                ItemProcessor: {
                  ProcessorConfig: {
                    Mode: "INLINE"
                  },
                  StartAt: "GetObjectFromBucket",
                  States: {
                    GetObjectFromBucket: {
                      Type: "Task",
                      Next: "TransformItem",
                      Parameters: {
                        Bucket: inputBucket.bucketName,
                        "Key.$": "$.Key"
                      },
                      Resource: "arn:aws:states:::aws-sdk:s3:getObject"
                    },
                    TransformItem: {
                      Type: "Pass",
                      Next: "PublishItem",
                      Parameters: {
                        "output.$": "States.JsonMerge(States.StringToJson($.Body), States.StringToJson('{\"NewField\": \"MyValue\" }'), false)"
                      },
                      OutputPath: "$.output"
                    },
                    PublishItem: {
                      Type: "Task",
                      Resource: "arn:aws:states:::sns:publish",
                      Parameters: {
                        "Message.$": "$",
                        TopicArn: topic.topicArn
                      },
                      End: true,
                      ResultPath: null
                    }
                  }
                },
                End: true
              }
            }
          },
          ItemReader: {
            Parameters: {
              Bucket: inputBucket.bucketName
            },
            Resource: "arn:aws:states:::s3:listObjectsV2"
          }
        }
      })
    .next(new Pass(this, 'Fail'))
    .next(new Pass(this, 'End'));

    const statemachineName = "MapStateMachine";

    const stateMachine = new StateMachine(this, 'StateMachine', {
      definition: definition,
      stateMachineName: statemachineName,
    });

    stateMachine.addToRolePolicy(
      new PolicyStatement({
        actions: ["states:StartExecution"],
        resources: [
          `arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT_ID}:stateMachine:${statemachineName}`,
        ],
      })
    );

    stateMachine.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "s3:listObjectsV2",
          "s3:getObject"],
        resources: [`${inputBucket.bucketArn}/*`],
      })
    );

    stateMachine.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [`${inputBucket.bucketArn}`],
      })
    );

    stateMachine.addToRolePolicy(
      new PolicyStatement({
        actions: ["sns:Publish"],
        resources: [topic.topicArn],
      })
    );
  }
}
