#import <AVFoundation/AVFoundation.h>
@interface OmniTestWakeAudioNode : NSObject
@property(nonatomic, readonly) AVAudioNode *audioNode;
@property(nonatomic) BOOL failInstallation;
@property(nonatomic, readonly) BOOL receivedNativeFormat;
@property(nonatomic, readonly) NSUInteger installations;
@end

@interface OmniTestWakeAudioEngine : NSObject
@property(nonatomic, readonly) AVAudioEngine *audioEngine;
@property(nonatomic) BOOL failPreparation;
@property(nonatomic) BOOL failStart;
@property(nonatomic, readonly) NSUInteger starts;
@end
