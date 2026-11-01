// Apple device access runs in the desktop process. Policy/approval checks belong
// to the authenticated desktop bridge; this layer also validates every input and
// never implicitly requests privacy access from a business operation.
#import <Foundation/Foundation.h>
#import <EventKit/EventKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <node_api.h>
#include <string>
#include <memory>
#include <cmath>
#include <atomic>
#include <chrono>
#include <mutex>

struct Work {
  napi_env env; napi_deferred deferred; napi_async_work work;
  std::string input; std::string output; std::string requestId;
  std::shared_ptr<std::atomic<bool>> cancelled = std::make_shared<std::atomic<bool>>(false);
  std::chrono::steady_clock::time_point deadline;
};
static std::mutex admissionMutex;
static Work *admittedWork = nullptr;
static thread_local Work *currentWork = nullptr;

static void Fail(NSString *code, NSString *message) {
  @throw [NSException exceptionWithName:[@"APPLE_DEVICE_" stringByAppendingString:code] reason:message userInfo:nil];
}
static void RequireActive(void) {
  if (!currentWork) Fail(@"UNAVAILABLE", @"Device operation is unavailable.");
  if (currentWork->cancelled->load(std::memory_order_acquire)) Fail(@"CANCELLED", @"Device operation was cancelled before completion.");
  if (std::chrono::steady_clock::now() >= currentWork->deadline) Fail(@"TIMEOUT", @"Device operation expired before completion. Check the item before retrying a change.");
}
static void WaitForSignal(dispatch_semaphore_t signal) {
  while (dispatch_semaphore_wait(signal, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC))) RequireActive();
  RequireActive();
}
static void ReleaseAdmission(Work *work) {
  std::lock_guard<std::mutex> lock(admissionMutex);
  if (admittedWork == work) admittedWork = nullptr;
}
static NSDictionary *Object(id value) {
  if (![value isKindOfClass:[NSDictionary class]]) Fail(@"INVALID_ARGUMENT", @"Expected an object.");
  return value;
}
static void Keys(NSDictionary *value, NSArray<NSString *> *allowed) {
  for (id key in value) if (![allowed containsObject:key]) Fail(@"INVALID_ARGUMENT", @"Unexpected argument.");
}
static NSString *String(id value, NSUInteger maximum, BOOL allowEmpty) {
  if (![value isKindOfClass:[NSString class]] || ![value canBeConvertedToEncoding:NSUTF8StringEncoding] ||
      [value rangeOfCharacterFromSet:[NSCharacterSet characterSetWithRange:NSMakeRange(0, 1)]].location != NSNotFound ||
      [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > maximum ||
      (!allowEmpty && ![[value stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet] length]))
    Fail(@"INVALID_ARGUMENT", @"Invalid text argument.");
  return value;
}
static BOOL ParamBoolean(id value) {
  if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID())
    Fail(@"INVALID_ARGUMENT", @"Expected a boolean.");
  return [value boolValue];
}
static NSInteger Integer(id value, NSInteger minimum, NSInteger maximum) {
  if (![value isKindOfClass:[NSNumber class]] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID() ||
      !std::isfinite([value doubleValue]) || [value doubleValue] != [value integerValue] ||
      [value integerValue] < minimum || [value integerValue] > maximum)
    Fail(@"INVALID_ARGUMENT", @"Invalid integer argument.");
  return [value integerValue];
}
static NSISO8601DateFormatter *Formatter(BOOL fractional) {
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new];
  formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | (fractional ? NSISO8601DateFormatWithFractionalSeconds : 0);
  return formatter;
}
static NSDate *Date(id value) {
  NSString *text = String(value, 64, NO);
  // Require an explicit timezone. Floating dates would change meaning by device.
  NSRegularExpression *zone = [NSRegularExpression regularExpressionWithPattern:@"(?:Z|[+-][0-9]{2}:[0-9]{2})$" options:0 error:nil];
  if (![zone firstMatchInString:text options:0 range:NSMakeRange(0, text.length)]) Fail(@"INVALID_ARGUMENT", @"Dates must include a timezone.");
  NSDate *date = [Formatter(YES) dateFromString:text] ?: [Formatter(NO) dateFromString:text];
  if (!date) Fail(@"INVALID_ARGUMENT", @"Invalid ISO date.");
  return date;
}
static id ISO(NSDate *date) { return date ? [Formatter(YES) stringFromDate:date] : (id)[NSNull null]; }
static NSString *JSON(id value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:NSJSONWritingSortedKeys error:nil];
  if (!data) Fail(@"FAILED", @"Unable to encode device result.");
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
static NSString *Hash(id value) {
  NSData *data = [JSON(value) dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString new];
  for (unsigned char byte : digest) [hex appendFormat:@"%02x", byte];
  return hex;
}
static NSString *Text(NSString *value, NSUInteger maximum) {
  if (!value) return @"";
  if ([value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= maximum) return value;
  // Truncate only at complete Unicode character boundaries; native result caps
  // apply even to records created outside Shoggoth.
  NSMutableString *result = [NSMutableString new];
  __block NSUInteger used = 0;
  [value enumerateSubstringsInRange:NSMakeRange(0, value.length) options:NSStringEnumerationByComposedCharacterSequences
    usingBlock:^(NSString *substring, NSRange range, NSRange enclosingRange, BOOL *stop) {
      (void)range; (void)enclosingRange;
      NSUInteger bytes = [substring lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
      if (used + bytes > maximum) *stop = YES;
      else { used += bytes; [result appendString:substring]; }
    }];
  return result;
}
static NSArray *Recurrence(EKCalendarItem *item) {
  NSMutableArray *rules = [NSMutableArray new];
  for (EKRecurrenceRule *rule in item.recurrenceRules) {
    NSMutableArray *weekdays = [NSMutableArray new];
    for (EKRecurrenceDayOfWeek *day in rule.daysOfTheWeek) [weekdays addObject:@[@(day.dayOfTheWeek), @(day.weekNumber)]];
    [rules addObject:@{@"frequency": @(rule.frequency), @"interval": @(rule.interval), @"firstDay": @(rule.firstDayOfTheWeek),
      @"weekdays": weekdays, @"monthDays": rule.daysOfTheMonth ?: @[], @"months": rule.monthsOfTheYear ?: @[],
      @"weeks": rule.weeksOfTheYear ?: @[], @"yearDays": rule.daysOfTheYear ?: @[], @"positions": rule.setPositions ?: @[],
      @"end": ISO(rule.recurrenceEnd.endDate), @"count": @(rule.recurrenceEnd.occurrenceCount)}];
  }
  return rules;
}
static NSDictionary *Components(NSDateComponents *value) {
  if (!value) return @{};
  return @{@"year": @(value.year), @"month": @(value.month), @"day": @(value.day), @"hour": @(value.hour),
    @"minute": @(value.minute), @"second": @(value.second), @"nanosecond": @(value.nanosecond),
    @"zone": value.timeZone.name ?: @"", @"calendar": value.calendar.calendarIdentifier ?: @""};
}
static NSString *Access(EKEntityType type) {
  EKAuthorizationStatus status = [EKEventStore authorizationStatusForEntityType:type];
  if (status == EKAuthorizationStatusNotDetermined) return @"notDetermined";
  if (status == EKAuthorizationStatusDenied) return @"denied";
  if (status == EKAuthorizationStatusRestricted) return @"restricted";
  if (@available(macOS 14.0, *)) {
    if (status == EKAuthorizationStatusFullAccess) return @"fullAccess";
    if (status == EKAuthorizationStatusWriteOnly) return @"writeOnly";
  } else if (status == EKAuthorizationStatusAuthorized) return @"fullAccess";
  return @"unavailable";
}
static NSDictionary *Status(void) { return @{@"calendar": Access(EKEntityTypeEvent), @"reminders": Access(EKEntityTypeReminder)}; }
static void RequireAccess(EKEntityType type) {
  if (![Access(type) isEqualToString:@"fullAccess"]) Fail(@"PERMISSION_REQUIRED", @"Connect this application in Your devices before accessing its data.");
}
static EKEventStore *Store(void) {
  RequireActive();
  // EventKit objects remain associated with this long-lived store. All callers
  // use the same serial queue, including revision checks and the following save.
  static EKEventStore *store;
  if (!store) store = [EKEventStore new];
  return store;
}
static EKCalendar *Calendar(id identifier, EKEntityType type, BOOL writing) {
  EKCalendar *calendar = identifier ? [Store() calendarWithIdentifier:String(identifier, 4096, NO)] :
    (type == EKEntityTypeEvent ? Store().defaultCalendarForNewEvents : Store().defaultCalendarForNewReminders);
  if (!calendar || !(calendar.allowedEntityTypes & (type == EKEntityTypeEvent ? EKEntityMaskEvent : EKEntityMaskReminder)))
    Fail(@"NOT_FOUND", @"The selected calendar or list no longer exists.");
  if (writing && !calendar.allowsContentModifications) Fail(@"READ_ONLY", @"The selected calendar or list is read only.");
  return calendar;
}
static NSArray<EKCalendar *> *Calendars(id value, EKEntityType type) {
  if (!value) return nil;
  if (![value isKindOfClass:[NSArray class]] || [value count] > 32)
    Fail(@"INVALID_ARGUMENT", @"Select at most 32 calendars or lists.");
  NSMutableArray *result = [NSMutableArray new];
  for (id identifier in value) [result addObject:Calendar(identifier, type, NO)];
  return result;
}
static NSString *EventID(EKEvent *event) {
  // eventWithIdentifier returns the first occurrence. Preserve the occurrence
  // start so updates/deletes cannot accidentally act on that first occurrence.
  NSString *encoded = JSON(@{@"id": event.eventIdentifier ?: @"", @"start": ISO(event.startDate)});
  return String([@"event:" stringByAppendingString:[[encoded dataUsingEncoding:NSUTF8StringEncoding] base64EncodedStringWithOptions:0]], 4096, NO);
}
static NSDictionary *EventDTO(EKEvent *event) {
  NSMutableDictionary *value = [@{@"id": EventID(event), @"calendarId": event.calendar.calendarIdentifier ?: @"",
    @"title": Text(event.title, 512), @"start": ISO(event.startDate), @"end": ISO(event.endDate), @"allDay": @(event.allDay),
    @"timeZone": Text(event.timeZone.name, 256), @"notes": Text(event.notes, 8192), @"location": Text(event.location, 2048),
    @"recurring": @(event.hasRecurrenceRules || event.isDetached)} mutableCopy];
  value[@"revision"] = Hash(@{@"record": value, @"modified": ISO(event.lastModifiedDate),
    @"recurrence": Recurrence(event), @"notes": event.notes ?: @"", @"title": event.title ?: @"", @"location": event.location ?: @""});
  return value;
}
static EKEvent *Event(id value) {
  NSString *identifier = String(value, 4096, NO);
  if (![identifier hasPrefix:@"event:"]) Fail(@"INVALID_ARGUMENT", @"Invalid event identifier.");
  NSData *data = [[NSData alloc] initWithBase64EncodedString:[identifier substringFromIndex:6] options:0];
  NSDictionary *identity = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![identity isKindOfClass:[NSDictionary class]]) Fail(@"INVALID_ARGUMENT", @"Invalid event identifier.");
  Keys(identity, @[@"id", @"start"]);
  NSString *eventIdentifier = String(identity[@"id"], 4096, NO);
  NSDate *start = Date(identity[@"start"]);
  EKEvent *event = [Store() eventWithIdentifier:eventIdentifier];
  if (!event) Fail(@"NOT_FOUND", @"The event no longer exists.");
  if (fabs([event.startDate timeIntervalSinceDate:start]) < 0.01) return event;
  // Resolve one occurrence in a two-second range in its known calendar.
  NSPredicate *predicate = [Store() predicateForEventsWithStartDate:[start dateByAddingTimeInterval:-1]
    endDate:[start dateByAddingTimeInterval:1] calendars:@[event.calendar]];
  __block EKEvent *match = nil;
  [Store() enumerateEventsMatchingPredicate:predicate usingBlock:^(EKEvent *candidate, BOOL *stop) {
    if ([candidate.eventIdentifier isEqualToString:eventIdentifier] && fabs([candidate.startDate timeIntervalSinceDate:start]) < 0.01) {
      match = candidate; *stop = YES;
    }
  }];
  if (!match) Fail(@"NOT_FOUND", @"The event occurrence no longer exists.");
  return match;
}
static NSDate *ReminderDue(EKReminder *reminder) {
  NSDateComponents *components = reminder.dueDateComponents;
  if (!components) return nil;
  NSCalendar *calendar = components.calendar ?: [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
  calendar.timeZone = components.timeZone ?: reminder.timeZone ?: NSTimeZone.localTimeZone;
  return [calendar dateFromComponents:components];
}
static NSDictionary *ReminderDTO(EKReminder *reminder) {
  NSMutableDictionary *value = [@{@"id": String([@"reminder:" stringByAppendingString:reminder.calendarItemIdentifier ?: @""], 4096, NO),
    @"listId": reminder.calendar.calendarIdentifier ?: @"", @"title": Text(reminder.title, 512), @"notes": Text(reminder.notes, 8192),
    @"due": ISO(ReminderDue(reminder)), @"priority": @(reminder.priority), @"completed": @(reminder.completed)} mutableCopy];
  value[@"revision"] = Hash(@{@"record": value, @"modified": ISO(reminder.lastModifiedDate),
    @"completion": ISO(reminder.completionDate), @"dueComponents": Components(reminder.dueDateComponents),
    @"recurrence": Recurrence(reminder), @"notes": reminder.notes ?: @"", @"title": reminder.title ?: @""});
  return value;
}
static EKReminder *Reminder(id value) {
  NSString *identifier = String(value, 4096, NO);
  if (![identifier hasPrefix:@"reminder:"]) Fail(@"INVALID_ARGUMENT", @"Invalid reminder identifier.");
  EKCalendarItem *item = [Store() calendarItemWithIdentifier:[identifier substringFromIndex:9]];
  if (![item isKindOfClass:[EKReminder class]]) Fail(@"NOT_FOUND", @"The reminder no longer exists.");
  return (EKReminder *)item;
}
static void Revision(NSDictionary *params, NSDictionary *current) {
  NSString *revision = String(params[@"expectedRevision"], 64, NO);
  if (revision.length != 64) Fail(@"INVALID_ARGUMENT", @"Invalid revision.");
  if (![revision isEqualToString:current[@"revision"]]) Fail(@"CONFLICT", @"This item changed. Read it again and approve the updated change.");
}
static EKSpan Span(id value) {
  NSString *scope = String(value, 16, NO);
  if ([scope isEqualToString:@"this"]) return EKSpanThisEvent;
  if ([scope isEqualToString:@"future"]) return EKSpanFutureEvents;
  Fail(@"INVALID_ARGUMENT", @"Choose this occurrence or this and future occurrences.");
  return EKSpanThisEvent;
}
static void ApplyEvent(EKEvent *event, NSDictionary *patch, BOOL creating) {
  Keys(patch, @[@"title", @"start", @"end", @"allDay", @"timeZone", @"notes", @"location", @"calendarId"]);
  if (patch[@"title"] || creating) event.title = String(patch[@"title"], 512, NO);
  if (patch[@"start"] || creating) event.startDate = Date(patch[@"start"]);
  if (patch[@"end"] || creating) event.endDate = Date(patch[@"end"]);
  if (patch[@"allDay"]) event.allDay = ParamBoolean(patch[@"allDay"]);
  if (patch[@"timeZone"]) {
    NSString *name = String(patch[@"timeZone"], 256, NO);
    NSTimeZone *zone = [NSTimeZone timeZoneWithName:name];
    if (!zone) Fail(@"INVALID_ARGUMENT", @"Unknown timezone.");
    event.timeZone = zone;
  }
  if (patch[@"notes"]) event.notes = String(patch[@"notes"], 8192, YES);
  if (patch[@"location"]) event.location = String(patch[@"location"], 2048, YES);
  if (patch[@"calendarId"] || creating) event.calendar = Calendar(patch[@"calendarId"], EKEntityTypeEvent, YES);
  if (!event.startDate || !event.endDate || [event.endDate compare:event.startDate] != NSOrderedDescending ||
      [event.endDate timeIntervalSinceDate:event.startDate] > 366 * 86400)
    Fail(@"INVALID_ARGUMENT", @"Event end must follow its start and duration must be at most 366 days.");
}
static void ApplyReminder(EKReminder *reminder, NSDictionary *patch, BOOL creating) {
  Keys(patch, @[@"title", @"notes", @"due", @"priority", @"listId", @"completed"]);
  if (patch[@"title"] || creating) reminder.title = String(patch[@"title"], 512, NO);
  if (patch[@"notes"]) reminder.notes = String(patch[@"notes"], 8192, YES);
  if (patch[@"priority"]) reminder.priority = Integer(patch[@"priority"], 0, 9);
  if (patch[@"completed"]) reminder.completed = ParamBoolean(patch[@"completed"]);
  if (patch[@"listId"] || creating) reminder.calendar = Calendar(patch[@"listId"], EKEntityTypeReminder, YES);
  if (patch[@"due"]) {
    if (patch[@"due"] == [NSNull null]) reminder.dueDateComponents = nil;
    else {
      NSDate *due = Date(patch[@"due"]);
      NSCalendar *calendar = [NSCalendar calendarWithIdentifier:NSCalendarIdentifierGregorian];
      calendar.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
      NSDateComponents *components = [calendar components:(NSCalendarUnitYear | NSCalendarUnitMonth | NSCalendarUnitDay |
        NSCalendarUnitHour | NSCalendarUnitMinute | NSCalendarUnitSecond) fromDate:due];
      components.calendar = calendar; components.timeZone = calendar.timeZone;
      reminder.dueDateComponents = components;
    }
  }
}
static void Saved(BOOL success, NSError *error) {
  (void)error;
  if (!success) Fail(@"FAILED", @"Apple did not confirm this change. Read the item before retrying.");
}
static id Invoke(NSString *operation, NSDictionary *params) {
  if ([operation isEqualToString:@"status"]) { Keys(params, @[]); return Status(); }
  RequireActive();
  if ([operation isEqualToString:@"requestAccess"]) {
    Keys(params, @[@"resource"]);
    NSString *resource = String(params[@"resource"], 16, NO);
    if (![@[@"calendar", @"reminders"] containsObject:resource]) Fail(@"INVALID_ARGUMENT", @"Unknown device application.");
    EKEntityType type = [resource isEqualToString:@"calendar"] ? EKEntityTypeEvent : EKEntityTypeReminder;
    NSString *access = Access(type);
    if (![access isEqualToString:@"notDetermined"] && ![access isEqualToString:@"writeOnly"]) return Status();
    dispatch_semaphore_t signal = dispatch_semaphore_create(0);
    const auto cancellation = currentWork->cancelled;
    const auto deadline = currentWork->deadline;
    dispatch_async(dispatch_get_main_queue(), ^{
      if (cancellation->load(std::memory_order_acquire) || std::chrono::steady_clock::now() >= deadline) { dispatch_semaphore_signal(signal); return; }
      // This store remains owned by the completion block if the user cancels
      // Shoggoth's wait while the system permission dialog is still visible.
      EKEventStore *permissionStore = [EKEventStore new];
      void (^completion)(BOOL, NSError *) = ^(BOOL granted, NSError *error) {
        (void)permissionStore; (void)granted; (void)error; dispatch_semaphore_signal(signal);
      };
      if (@available(macOS 14.0, *)) {
        if (type == EKEntityTypeEvent) [permissionStore requestFullAccessToEventsWithCompletion:completion];
        else [permissionStore requestFullAccessToRemindersWithCompletion:completion];
      } else [permissionStore requestAccessToEntityType:type completion:completion];
    });
    WaitForSignal(signal);
    return Status();
  }
  NSSet *eventOperations = [NSSet setWithArray:@[@"calendar.list", @"calendar.events", @"calendar.get", @"calendar.create", @"calendar.update", @"calendar.delete"]];
  NSSet *reminderOperations = [NSSet setWithArray:@[@"reminders.lists", @"reminders.search", @"reminders.get", @"reminders.create", @"reminders.update", @"reminders.delete"]];
  BOOL isEvent = [eventOperations containsObject:operation];
  if (!isEvent && ![reminderOperations containsObject:operation]) Fail(@"INVALID_ARGUMENT", @"Unknown device operation.");
  EKEntityType type = isEvent ? EKEntityTypeEvent : EKEntityTypeReminder;
  RequireAccess(type);
  // Flush cached records between calls, so optimistic revisions see changes made
  // by Calendar/Reminders or synchronization since the preceding invocation.
  [Store() reset];
  if ([operation isEqualToString:@"calendar.list"] || [operation isEqualToString:@"reminders.lists"]) {
    Keys(params, @[]);
    EKCalendar *defaultCalendar = isEvent ? Store().defaultCalendarForNewEvents : Store().defaultCalendarForNewReminders;
    NSMutableArray *result = [NSMutableArray new];
    for (EKCalendar *calendar in [Store() calendarsForEntityType:type]) {
      if (result.count >= 100) Fail(@"FAILED", @"Too many calendars or lists to return.");
      [result addObject:@{@"id": calendar.calendarIdentifier ?: @"", @"title": Text(calendar.title, 512),
        @"allowsModifications": @(calendar.allowsContentModifications), @"isDefault": @([calendar.calendarIdentifier isEqualToString:defaultCalendar.calendarIdentifier])}];
    }
    return @{isEvent ? @"calendars" : @"lists": result};
  }
  if ([operation isEqualToString:@"calendar.events"]) {
    Keys(params, @[@"start", @"end", @"calendarIds", @"limit"]);
    NSDate *start = Date(params[@"start"]), *end = Date(params[@"end"]);
    if ([end compare:start] != NSOrderedDescending || [end timeIntervalSinceDate:start] > 366 * 86400)
      Fail(@"INVALID_ARGUMENT", @"Choose a positive date range of at most 366 days.");
    NSInteger limit = params[@"limit"] ? Integer(params[@"limit"], 1, 100) : 100;
    NSArray *calendars = Calendars(params[@"calendarIds"], type);
    if (calendars && !calendars.count) return @{@"events": @[], @"truncated": @NO};
    NSPredicate *predicate = [Store() predicateForEventsWithStartDate:start endDate:end calendars:calendars];
    NSMutableArray *events = [NSMutableArray new]; __block BOOL truncated = NO;
    [Store() enumerateEventsMatchingPredicate:predicate usingBlock:^(EKEvent *event, BOOL *stop) {
      if ((NSInteger)events.count >= limit) { truncated = YES; *stop = YES; }
      else {
        [events addObject:EventDTO(event)];
        if ([JSON(events) lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 44000) { [events removeLastObject]; truncated = YES; *stop = YES; }
      }
    }];
    [events sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"start"] compare:b[@"start"]]; }];
    return @{@"events": events, @"truncated": @(truncated)};
  }
  if ([operation isEqualToString:@"reminders.search"]) {
    Keys(params, @[@"listIds", @"completed", @"limit"]);
    NSInteger limit = params[@"limit"] ? Integer(params[@"limit"], 1, 100) : 100;
    NSArray *calendars = Calendars(params[@"listIds"], type);
    if (calendars && !calendars.count) return @{@"reminders": @[], @"truncated": @NO};
    NSPredicate *predicate;
    if (!params[@"completed"]) predicate = [Store() predicateForRemindersInCalendars:calendars];
    else if (ParamBoolean(params[@"completed"])) predicate = [Store() predicateForCompletedRemindersWithCompletionDateStarting:nil ending:nil calendars:calendars];
    else predicate = [Store() predicateForIncompleteRemindersWithDueDateStarting:nil ending:nil calendars:calendars];
    dispatch_semaphore_t signal = dispatch_semaphore_create(0);
    __block NSArray *fetched = nil;
    EKEventStore *fetchStore = Store();
    id fetch = [fetchStore fetchRemindersMatchingPredicate:predicate completion:^(NSArray<EKReminder *> *reminders) { fetched = reminders; dispatch_semaphore_signal(signal); }];
    @try { WaitForSignal(signal); }
    @catch (NSException *exception) { [fetchStore cancelFetchRequest:fetch]; @throw exception; }
    if (!fetched) Fail(@"FAILED", @"Unable to read reminders.");
    NSMutableArray *result = [NSMutableArray new];
    for (EKReminder *reminder in fetched) {
      if ((NSInteger)result.count == limit) break;
      [result addObject:ReminderDTO(reminder)];
      if ([JSON(result) lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 44000) { [result removeLastObject]; break; }
    }
    return @{@"reminders": result, @"truncated": @(fetched.count > result.count)};
  }
  if ([operation hasSuffix:@".get"]) {
    Keys(params, @[@"id"]);
    return isEvent ? @{@"event": EventDTO(Event(params[@"id"]))} : @{@"reminder": ReminderDTO(Reminder(params[@"id"]))};
  }
  if ([operation hasSuffix:@".create"]) {
    NSError *error = nil;
    if (isEvent) {
      EKEvent *event = [EKEvent eventWithEventStore:Store()];
      ApplyEvent(event, params, YES); RequireAccess(type);
      BOOL saved = [Store() saveEvent:event span:EKSpanThisEvent commit:YES error:&error]; Saved(saved, error);
      if (!event.eventIdentifier) Fail(@"FAILED", @"Apple did not confirm the created event. Read the calendar before retrying.");
      return @{@"event": EventDTO(event)};
    }
    // completed is available only as a separate approved update.
    Keys(params, @[@"listId", @"title", @"notes", @"due", @"priority"]);
    EKReminder *reminder = [EKReminder reminderWithEventStore:Store()];
    ApplyReminder(reminder, params, YES); RequireAccess(type);
    BOOL saved = [Store() saveReminder:reminder commit:YES error:&error]; Saved(saved, error);
    if (!reminder.calendarItemIdentifier) Fail(@"FAILED", @"Apple did not confirm the created reminder. Read the list before retrying.");
    return @{@"reminder": ReminderDTO(reminder)};
  }
  BOOL deleting = [operation hasSuffix:@".delete"];
  Keys(params, isEvent ? (deleting ? @[@"id", @"expectedRevision", @"scope"] : @[@"id", @"expectedRevision", @"scope", @"patch"]) :
    (deleting ? @[@"id", @"expectedRevision"] : @[@"id", @"expectedRevision", @"patch"]));
  NSError *error = nil;
  if (isEvent) {
    EKSpan span = Span(params[@"scope"]); EKEvent *event = Event(params[@"id"]);
    Revision(params, EventDTO(event)); Calendar(event.calendar.calendarIdentifier, type, YES);
    if (deleting) { RequireAccess(type); BOOL saved = [Store() removeEvent:event span:span commit:YES error:&error]; Saved(saved, error); return @{@"deleted": @YES, @"id": params[@"id"]}; }
    NSDictionary *patch = Object(params[@"patch"]); if (!patch.count) Fail(@"INVALID_ARGUMENT", @"The change is empty.");
    ApplyEvent(event, patch, NO); RequireAccess(type);
    BOOL saved = [Store() saveEvent:event span:span commit:YES error:&error]; Saved(saved, error); return @{@"event": EventDTO(event)};
  }
  EKReminder *reminder = Reminder(params[@"id"]);
  Revision(params, ReminderDTO(reminder)); Calendar(reminder.calendar.calendarIdentifier, type, YES);
  if (deleting) { RequireAccess(type); BOOL saved = [Store() removeReminder:reminder commit:YES error:&error]; Saved(saved, error); return @{@"deleted": @YES, @"id": params[@"id"]}; }
  NSDictionary *patch = Object(params[@"patch"]); if (!patch.count) Fail(@"INVALID_ARGUMENT", @"The change is empty.");
  ApplyReminder(reminder, patch, NO); RequireAccess(type);
  BOOL saved = [Store() saveReminder:reminder commit:YES error:&error]; Saved(saved, error); return @{@"reminder": ReminderDTO(reminder)};
}

static void Execute(napi_env env, void *data) {
  (void)env; Work *work = static_cast<Work *>(data);
  static dispatch_queue_t queue; static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("com.shoggoth.apple-device", DISPATCH_QUEUE_SERIAL); });
  void (^run)(void) = ^{ @autoreleasepool {
    Work *previousWork = currentWork; currentWork = work;
    @try {
    RequireActive();
    NSData *input = [NSData dataWithBytes:work->input.data() length:work->input.length()];
    NSDictionary *request = Object([NSJSONSerialization JSONObjectWithData:input options:0 error:nil]);
    Keys(request, @[@"operation", @"params", @"requestId"]);
    if (request[@"requestId"]) String(request[@"requestId"], 128, NO);
    NSString *operation = String(request[@"operation"], 64, NO);
    id result = Invoke(operation, Object(request[@"params"]));
    RequireActive();
    NSString *encoded = JSON(@{@"ok": @YES, @"result": result});
    if ([encoded lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 49152) Fail(@"FAILED", @"Device response exceeds the size limit. Select fewer calendars or lists.");
    work->output = [encoded UTF8String];
  } @catch (NSException *exception) {
    NSString *code = [exception.name hasPrefix:@"APPLE_DEVICE_"] ? exception.name : @"APPLE_DEVICE_FAILED";
    NSString *message = [exception.name hasPrefix:@"APPLE_DEVICE_"] ? exception.reason : @"Apple device operation failed.";
    work->output = [JSON(@{@"ok": @NO, @"error": @{@"code": code, @"message": message ?: @"Apple device operation failed."}}) UTF8String];
  } @finally { currentWork = previousWork; } } };
  @autoreleasepool {
    // Authorization dialogs wait for human input until the request is canceled.
    // Status only uses non-prompting class APIs, so it must remain responsive
    // while a dialog occupies the serial store queue.
    NSData *input = [NSData dataWithBytes:work->input.data() length:work->input.length()];
    id request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    BOOL statusOnly = [request isKindOfClass:[NSDictionary class]] && [request[@"operation"] isEqual:@"status"];
    if (statusOnly) run(); else dispatch_sync(queue, run);
  }
}
static void Complete(napi_env env, napi_status status, void *data) {
  std::unique_ptr<Work> work(static_cast<Work *>(data)); napi_value value;
  ReleaseAdmission(work.get());
  if (status != napi_ok) work->output = "{\"ok\":false,\"error\":{\"code\":\"APPLE_DEVICE_UNAVAILABLE\",\"message\":\"Device operation was cancelled.\"}}";
  napi_create_string_utf8(env, work->output.data(), work->output.length(), &value);
  napi_resolve_deferred(env, work->deferred, value); napi_delete_async_work(env, work->work);
}
static napi_value InvokeJS(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype type; size_t length = 0;
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || length > 65536) {
    napi_throw_type_error(env, "APPLE_DEVICE_INVALID_ARGUMENT", "Expected a JSON request of at most 64 KiB."); return nullptr;
  }
  auto work = std::make_unique<Work>(); work->env = env; work->input.resize(length + 1);
  napi_get_value_string_utf8(env, argv[0], work->input.data(), length + 1, &length); work->input.resize(length);
  napi_value promise, name; napi_create_promise(env, &work->deferred, &promise);
  @autoreleasepool {
    NSData *input = [NSData dataWithBytes:work->input.data() length:work->input.length()];
    id request = [NSJSONSerialization JSONObjectWithData:input options:0 error:nil];
    BOOL authorization = [request isKindOfClass:[NSDictionary class]] && [request[@"operation"] isEqual:@"requestAccess"];
    work->deadline = authorization ? std::chrono::steady_clock::time_point::max()
      : std::chrono::steady_clock::now() + std::chrono::seconds(30);
    if ([request isKindOfClass:[NSDictionary class]] && [request[@"requestId"] isKindOfClass:[NSString class]] &&
        [request[@"requestId"] lengthOfBytesUsingEncoding:NSUTF8StringEncoding] <= 128 && [request[@"requestId"] UTF8String])
      work->requestId = [request[@"requestId"] UTF8String];
    if ([request isKindOfClass:[NSDictionary class]] && [request[@"operation"] isEqual:@"status"]) {
      // Do not occupy libuv's worker pool for class-only status checks: several
      // queued data calls behind an authorization dialog could exhaust that
      // pool. Return an already-resolved Promise after strict validation.
      Execute(env, work.get()); napi_value value;
      napi_create_string_utf8(env, work->output.data(), work->output.length(), &value);
      napi_resolve_deferred(env, work->deferred, value); return promise;
    }
  }
  {
    std::lock_guard<std::mutex> lock(admissionMutex);
    if (admittedWork) {
      const char *busy = "{\"ok\":false,\"error\":{\"code\":\"APPLE_DEVICE_BUSY\",\"message\":\"Another device operation is still active.\"}}";
      napi_value value; napi_create_string_utf8(env, busy, NAPI_AUTO_LENGTH, &value);
      napi_resolve_deferred(env, work->deferred, value); return promise;
    }
    admittedWork = work.get();
  }
  napi_create_string_utf8(env, "apple-device", NAPI_AUTO_LENGTH, &name);
  if (napi_create_async_work(env, nullptr, name, Execute, Complete, work.get(), &work->work) != napi_ok) {
    ReleaseAdmission(work.get());
    napi_throw_error(env, "APPLE_DEVICE_UNAVAILABLE", "Unable to schedule the device operation."); return nullptr;
  }
  if (napi_queue_async_work(env, work->work) != napi_ok) {
    ReleaseAdmission(work.get());
    napi_delete_async_work(env, work->work);
    napi_throw_error(env, "APPLE_DEVICE_UNAVAILABLE", "Unable to schedule the device operation."); return nullptr;
  }
  work.release(); return promise;
}
static napi_value CancelJS(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0; napi_value argv[1]; napi_valuetype type;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || !length || length > 128) {
    napi_throw_type_error(env, "APPLE_DEVICE_INVALID_ARGUMENT", "Invalid internal device request identifier."); return nullptr;
  }
  std::string requestId(length + 1, '\0');
  napi_get_value_string_utf8(env, argv[0], requestId.data(), length + 1, &length); requestId.resize(length);
  bool cancelled = false;
  {
    std::lock_guard<std::mutex> lock(admissionMutex);
    if (admittedWork && admittedWork->requestId == requestId) {
      admittedWork->cancelled->store(true, std::memory_order_release); cancelled = true;
    }
  }
  napi_value result; napi_get_boolean(env, cancelled, &result); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"invoke", nullptr, InvokeJS, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"cancel", nullptr, CancelJS, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, descriptors); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
